/**
 * Serviço de execução de testes de velocidade baseado em @cloudflare/speedtest ^1.13.1.
 * Gerencia ciclo de vida, proteção contra callbacks obsoletos (runId), timeout,
 * progresso contínuo e extração estruturada de telemetria.
 */

import SpeedTest from '@cloudflare/speedtest';
import { TEST_PROFILES } from '../config/speedtest.config.js';
import {
  checkBrowserCapabilities,
  clamp,
  isNonNegativeNumber,
  METRIC_STATUS,
  resolveMetric,
  sanitizeBandwidthPoints,
  sanitizeLatencyPoints
} from '../utils/validators.js';
import {
  bpsToMbps,
  calculateLatencyDelta,
  computeStats
} from '../utils/formatters.js';

export class SpeedTestService {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.instance = null;
    this.running = false;
    this.runId = 0;
    this.activeProfile = TEST_PROFILES.standard;
    this.startedAt = 0;
    this.lastActivityAt = 0;
    this.watchdogTimer = null;

    this.stepTracker = {
      totalSteps: 0,
      completedSteps: 0,
      currentPhase: 'idle',
      sawWarmupDownload: false,
      sawMainLatency: false
    };

    this.livePeakDownloadMbps = null;
    this.livePeakUploadMbps = null;
  }

  isRunning() {
    return this.running;
  }

  start(profileId = 'standard', context = {}) {
    if (this.running) {
      this.cancel();
    }

    const caps = checkBrowserCapabilities();
    if (!caps.supported) {
      this._emitError({
        code: 'UNSUPPORTED_BROWSER',
        message: `Navegador incompatível. Recursos ausentes: ${caps.missing.join(', ')}.`
      });
      return;
    }

    if (!caps.online) {
      this._emitError({
        code: 'OFFLINE',
        message: 'Sem conexão de rede detectada pelo navegador. Verifique o cabo ou Wi-Fi e tente novamente.'
      });
      return;
    }

    const profile = TEST_PROFILES[profileId] || TEST_PROFILES.standard;
    this.activeProfile = profile;
    this.runId += 1;
    const currentRunId = this.runId;

    this.running = true;
    this.startedAt = performance.now();
    this.lastActivityAt = this.startedAt;
    this.livePeakDownloadMbps = null;
    this.livePeakUploadMbps = null;

    const measurements = profile.options.measurements || [];
    this.stepTracker = {
      totalSteps: measurements.length,
      completedSteps: 0,
      currentPhase: 'latency',
      sawWarmupDownload: false,
      sawMainLatency: false
    };

    this._startWatchdog(currentRunId, profile);

    if (typeof this.callbacks.onStart === 'function') {
      this.callbacks.onStart({
        runId: currentRunId,
        profile,
        context
      });
    }

    try {
      const engine = new SpeedTest(profile.options);
      this.instance = engine;

      engine.onRunningChange = (isRunning) => {
        if (currentRunId !== this.runId) return;
        this.running = Boolean(isRunning);
      };

      engine.onResultsChange = (info) => {
        if (currentRunId !== this.runId || !this.running) return;
        this.lastActivityAt = performance.now();
        this._handleProgressEvent(info?.type, engine.results, currentRunId, context);
      };

      engine.onFinish = (results) => {
        if (currentRunId !== this.runId) return;
        this._cleanupWatchdog();
        this.running = false;
        const consolidated = this._buildConsolidatedResult(results, profile, context, false);
        this.instance = null;
        if (typeof this.callbacks.onFinish === 'function') {
          this.callbacks.onFinish(consolidated);
        }
      };

      engine.onError = (err) => {
        if (currentRunId !== this.runId) return;
        this._cleanupWatchdog();
        const partial = engine?.results
          ? this._buildConsolidatedResult(engine.results, profile, context, true)
          : null;
        this.running = false;
        this.instance = null;

        this._emitError({
          code: 'ENGINE_ERROR',
          message:
            typeof err === 'string'
              ? err
              : err?.message || 'Falha de comunicação com os servidores de medição.',
          partialResult: partial
        });
      };

      engine.play();
    } catch (error) {
      this._cleanupWatchdog();
      this.running = false;
      this.instance = null;
      this._emitError({
        code: 'INIT_ERROR',
        message: error?.message || 'Erro inesperado ao inicializar o motor de medição.'
      });
    }
  }

  cancel() {
    if (!this.running && !this.instance) {
      return;
    }

    this.runId += 1;
    this.running = false;
    this._cleanupWatchdog();

    if (this.instance) {
      try {
        this.instance.pause();
      } catch {
        // Ignora erro ao pausar instância descartada
      }
      this.instance = null;
    }

    if (typeof this.callbacks.onCancel === 'function') {
      this.callbacks.onCancel();
    }
  }

  _startWatchdog(currentRunId, profile) {
    this._cleanupWatchdog();
    this.watchdogTimer = window.setInterval(() => {
      if (currentRunId !== this.runId || !this.running) {
        this._cleanupWatchdog();
        return;
      }

      const now = performance.now();
      const elapsedTotal = now - this.startedAt;
      const elapsedIdle = now - this.lastActivityAt;

      if (elapsedTotal > profile.timeoutMs || elapsedIdle > profile.inactivityTimeoutMs) {
        const partial = this.instance?.results
          ? this._buildConsolidatedResult(this.instance.results, profile, {}, true)
          : null;

        this.runId += 1;
        this.running = false;
        this._cleanupWatchdog();

        if (this.instance) {
          try {
            this.instance.pause();
          } catch {
            // noop
          }
          this.instance = null;
        }

        this._emitError({
          code: 'TIMEOUT',
          message:
            elapsedIdle > profile.inactivityTimeoutMs
              ? 'Tempo limite de resposta atingido sem novas amostras da rede.'
              : 'Tempo máximo de execução do perfil excedido.',
          partialResult: partial
        });
      }
    }, 1000);
  }

  _cleanupWatchdog() {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  _emitError(payload) {
    if (typeof this.callbacks.onError === 'function') {
      this.callbacks.onError(payload);
    }
  }

  _handleProgressEvent(type, results, currentRunId, context) {
    if (!results) return;

    if (type) {
      this.stepTracker.completedSteps = Math.min(
        this.stepTracker.totalSteps,
        this.stepTracker.completedSteps + 1
      );

      // Identifica a fase real sem confundir o pacote único de warm-up inicial
      if (type === 'latency') {
        this.stepTracker.currentPhase = 'latency';
      } else if (type === 'download') {
        if (!this.stepTracker.sawWarmupDownload && this.stepTracker.completedSteps <= 2) {
          this.stepTracker.sawWarmupDownload = true;
          this.stepTracker.currentPhase = 'latency';
        } else {
          this.stepTracker.currentPhase = 'download';
        }
      } else if (type === 'upload') {
        this.stepTracker.currentPhase = 'upload';
      }
    }

    const rawRatio =
      this.stepTracker.totalSteps > 0
        ? (this.stepTracker.completedSteps / this.stepTracker.totalSteps) * 96
        : 5;
    const progressPercent = clamp(Math.round(rawRatio), 3, 96);

    const snapshot = this._extractSnapshot(results, false);

    if (isNonNegativeNumber(snapshot.currentDownloadMbps)) {
      this.livePeakDownloadMbps = Math.max(
        this.livePeakDownloadMbps ?? 0,
        snapshot.peakDownloadMbps ?? snapshot.currentDownloadMbps
      );
    }
    if (isNonNegativeNumber(snapshot.currentUploadMbps)) {
      this.livePeakUploadMbps = Math.max(
        this.livePeakUploadMbps ?? 0,
        snapshot.peakUploadMbps ?? snapshot.currentUploadMbps
      );
    }

    if (typeof this.callbacks.onProgress === 'function') {
      this.callbacks.onProgress({
        runId: currentRunId,
        phase: this.stepTracker.currentPhase,
        progressPercent,
        snapshot,
        peakDownloadMbps: this.livePeakDownloadMbps,
        peakUploadMbps: this.livePeakUploadMbps,
        context
      });
    }
  }

  _extractSnapshot(results, hasError) {
    let dlPoints = [];
    let ulPoints = [];
    let idleLatPoints = [];
    let dlLatPoints = [];
    let ulLatPoints = [];

    try {
      dlPoints = sanitizeBandwidthPoints(results.getDownloadBandwidthPoints());
    } catch {
      dlPoints = [];
    }

    try {
      ulPoints = sanitizeBandwidthPoints(results.getUploadBandwidthPoints());
    } catch {
      ulPoints = [];
    }

    try {
      idleLatPoints = sanitizeLatencyPoints(results.getUnloadedLatencyPoints());
    } catch {
      idleLatPoints = [];
    }

    try {
      dlLatPoints = sanitizeLatencyPoints(results.getDownLoadedLatencyPoints());
    } catch {
      dlLatPoints = [];
    }

    try {
      ulLatPoints = sanitizeLatencyPoints(results.getUpLoadedLatencyPoints());
    } catch {
      ulLatPoints = [];
    }

    const latestDl = dlPoints.length > 0 ? dlPoints[dlPoints.length - 1].mbps : null;
    const latestUl = ulPoints.length > 0 ? ulPoints[ulPoints.length - 1].mbps : null;
    const peakDl =
      dlPoints.length > 0 ? Math.max(...dlPoints.map((p) => p.mbps)) : null;
    const peakUl =
      ulPoints.length > 0 ? Math.max(...ulPoints.map((p) => p.mbps)) : null;

    let rawDlBps = null;
    let rawUlBps = null;
    let rawPing = null;
    let rawJitter = null;
    let rawDlLat = null;
    let rawUlLat = null;
    let rawDlJitter = null;
    let rawUlJitter = null;

    try {
      rawDlBps = results.getDownloadBandwidth();
    } catch {
      rawDlBps = null;
    }

    try {
      rawUlBps = results.getUploadBandwidth();
    } catch {
      rawUlBps = null;
    }

    try {
      rawPing = results.getUnloadedLatency();
    } catch {
      rawPing = null;
    }

    try {
      rawJitter = results.getUnloadedJitter();
    } catch {
      rawJitter = null;
    }

    try {
      rawDlLat = results.getDownLoadedLatency();
    } catch {
      rawDlLat = null;
    }

    try {
      rawUlLat = results.getUpLoadedLatency();
    } catch {
      rawUlLat = null;
    }

    try {
      rawDlJitter = results.getDownLoadedJitter();
    } catch {
      rawDlJitter = null;
    }

    try {
      rawUlJitter = results.getUpLoadedJitter();
    } catch {
      rawUlJitter = null;
    }

    const downloadMetric = resolveMetric(bpsToMbps(rawDlBps), 'Mbps', hasError);
    const uploadMetric = resolveMetric(bpsToMbps(rawUlBps), 'Mbps', hasError);
    const pingMetric = resolveMetric(rawPing, 'ms', hasError);
    const jitterMetric = resolveMetric(rawJitter, 'ms', hasError);
    const downloadLatencyMetric = resolveMetric(rawDlLat, 'ms', hasError);
    const uploadLatencyMetric = resolveMetric(rawUlLat, 'ms', hasError);
    const downloadJitterMetric = resolveMetric(rawDlJitter, 'ms', hasError);
    const uploadJitterMetric = resolveMetric(rawUlJitter, 'ms', hasError);

    return {
      currentDownloadMbps: latestDl,
      currentUploadMbps: latestUl,
      peakDownloadMbps: peakDl,
      peakUploadMbps: peakUl,
      metrics: {
        download: downloadMetric,
        upload: uploadMetric,
        ping: pingMetric,
        jitter: jitterMetric,
        downloadLatency: downloadLatencyMetric,
        uploadLatency: uploadLatencyMetric,
        downloadJitter: downloadJitterMetric,
        uploadJitter: uploadJitterMetric
      },
      series: {
        downloadPoints: dlPoints,
        uploadPoints: ulPoints,
        unloadedLatencyPoints: idleLatPoints,
        downloadLatencyPoints: dlLatPoints,
        uploadLatencyPoints: ulLatPoints
      }
    };
  }

  _buildConsolidatedResult(results, profile, context, incomplete) {
    const durationMs = Math.max(0, performance.now() - this.startedAt);
    const snapshot = this._extractSnapshot(results, incomplete);

    let summary = null;
    try {
      summary = typeof results.getSummary === 'function' ? results.getSummary() : null;
    } catch {
      summary = null;
    }

    const dlPoints = snapshot.series.downloadPoints;
    const ulPoints = snapshot.series.uploadPoints;
    const idleLatPoints = snapshot.series.unloadedLatencyPoints;
    const dlLatPoints = snapshot.series.downloadLatencyPoints;
    const ulLatPoints = snapshot.series.uploadLatencyPoints;

    const finalPeakDownload = Math.max(
      this.livePeakDownloadMbps ?? 0,
      snapshot.peakDownloadMbps ?? 0,
      snapshot.metrics.download.value ?? 0
    );

    const finalPeakUpload = Math.max(
      this.livePeakUploadMbps ?? 0,
      snapshot.peakUploadMbps ?? 0,
      snapshot.metrics.upload.value ?? 0
    );

    const downloadLatencyDelta = calculateLatencyDelta(
      snapshot.metrics.ping.value,
      snapshot.metrics.downloadLatency.value
    );

    const uploadLatencyDelta = calculateLatencyDelta(
      snapshot.metrics.ping.value,
      snapshot.metrics.uploadLatency.value
    );

    const totalDownloadBytes = dlPoints.reduce((acc, p) => acc + (p.bytes || 0), 0);
    const totalUploadBytes = ulPoints.reduce((acc, p) => acc + (p.bytes || 0), 0);

    return {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      incomplete,
      durationMs,
      profile: {
        id: profile.id,
        label: profile.label
      },
      context: {
        linkType: context.linkType || 'nao-informado',
        contractedMbps: isNonNegativeNumber(context.contractedMbps) && context.contractedMbps > 0
          ? context.contractedMbps
          : null,
        notes: typeof context.notes === 'string' ? context.notes.trim() : ''
      },
      metrics: {
        ...snapshot.metrics,
        peakDownload:
          dlPoints.length > 0 || snapshot.metrics.download.status === METRIC_STATUS.MEASURED
            ? resolveMetric(finalPeakDownload, 'Mbps', false)
            : resolveMetric(null, 'Mbps', incomplete),
        peakUpload:
          ulPoints.length > 0 || snapshot.metrics.upload.status === METRIC_STATUS.MEASURED
            ? resolveMetric(finalPeakUpload, 'Mbps', false)
            : resolveMetric(null, 'Mbps', incomplete),
        downloadLatencyDelta: resolveMetric(downloadLatencyDelta, 'ms', false),
        uploadLatencyDelta: resolveMetric(uploadLatencyDelta, 'ms', false)
      },
      stats: {
        download: computeStats(dlPoints.map((p) => p.mbps)),
        upload: computeStats(ulPoints.map((p) => p.mbps)),
        unloadedLatency: computeStats(idleLatPoints.map((p) => p.ms)),
        downloadLatency: computeStats(dlLatPoints.map((p) => p.ms)),
        uploadLatency: computeStats(ulLatPoints.map((p) => p.ms))
      },
      transfer: {
        totalDownloadBytes,
        totalUploadBytes,
        totalBytes: totalDownloadBytes + totalUploadBytes
      },
      series: snapshot.series,
      rawSummary: summary
    };
  }
}