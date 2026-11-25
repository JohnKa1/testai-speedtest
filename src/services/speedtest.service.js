/**
 * Motor de medição multi-stream resiliente do TestAi (estilo Fast.com)
 * contra Cloudflare Edge (https://speed.cloudflare.com/__down e /__up).
 * Gerencia múltiplos fluxos paralelos em streaming, janela deslizante de 1s,
 * recuperação silenciosa de stalls individuais, downshift automático em 429/403
 * e extração de RTT real via Resource Timing + Server-Timing (cfL4 rtt).
 */

import { TEST_PROFILES } from '../config/speedtest.config.js';
import {
  DEFAULT_RUNTIME_CONFIG,
  getRuntimeConfig,
  resolveRuntimeRoute
} from './runtime-config.js';
import { analyzeLoadedLatencySpikes } from '../diagnostics/connection-diagnostics.js';
import {
  checkBrowserCapabilities,
  clamp,
  isNonNegativeNumber,
  isPositiveNumber,
  isValidNumber,
  METRIC_STATUS,
  resolveMetric,
  sanitizeBandwidthPoints,
  sanitizeLatencyPoints
} from '../utils/validators.js';
import {
  bpsToMbps,
  calculateLatencyDelta,
  computePercentile,
  computeStats
} from '../utils/formatters.js';

export const MIN_VALID_NETWORK_RTT_MS = 0.05;
export const MAX_VALID_NETWORK_RTT_MS = 2000;
export const MAX_HTTP1_SAFE_STREAMS = 4;
export const DEFAULT_IDLE_PING_INTERVAL_MS = 60;

export function parseServerTiming(header) {
  if (!header || typeof header !== 'string') {
    return { serverMs: 0, tcpRttMs: null };
  }

  let serverMs = 0;
  for (const match of header.matchAll(/(?:^|,\s*)cfSpeed[a-zA-Z]*;\s*dur=([0-9.]+)/gi)) {
    serverMs += Number(match[1]) || 0;
  }
  if (serverMs === 0) {
    const reqDurMatch = header.match(/(?:^|,\s*)cfReq(?:uest)?Dur(?:ation)?;\s*dur=([0-9.]+)/i);
    if (reqDurMatch) {
      serverMs = Number(reqDurMatch[1]) || 0;
    }
  }
  if (serverMs === 0) {
    const appDurMatch = header.match(/(?:^|,\s*)app(?:;[^,]*)?;\s*dur=([0-9.]+)/i);
    if (appDurMatch) {
      serverMs = Number(appDurMatch[1]) || 0;
    }
  }

  const rttMatch = header.match(/rtt=(\d+)/i);
  const tcpRttMs = rttMatch ? Number(rttMatch[1]) / 1000 : null;

  return { serverMs, tcpRttMs };
}

/**
 * @param {{
 *   wallMs?: number,
 *   resourceTtfbMs?: number | null,
 *   serverTimingHeader?: string,
 *   isLoaded?: boolean
 * }} [params]
 * @returns {number}
 */
export function resolveNetworkRttMs({
  wallMs,
  resourceTtfbMs = null,
  serverTimingHeader = '',
  isLoaded = false
} = {}) {
  const hasWall = isNonNegativeNumber(wallMs) && wallMs > 0;
  const safeWallMs = hasWall ? wallMs : 1;
  const hasResourceTtfb = isNonNegativeNumber(resourceTtfbMs) && resourceTtfbMs > 0;
  const baseTtfb = hasResourceTtfb ? resourceTtfbMs : safeWallMs;

  const { serverMs, tcpRttMs } = parseServerTiming(serverTimingHeader);
  const httpNet = baseTtfb - serverMs;
  const validTcpRtt =
    isNonNegativeNumber(tcpRttMs) &&
    tcpRttMs >= MIN_VALID_NETWORK_RTT_MS &&
    tcpRttMs <= MAX_VALID_NETWORK_RTT_MS;
  const validHttpNet =
    isNonNegativeNumber(httpNet) &&
    httpNet >= MIN_VALID_NETWORK_RTT_MS &&
    httpNet <= MAX_VALID_NETWORK_RTT_MS;

  // Protege o RTT contra picos artificiais de processamento no Worker da borda (cfSpeedWorker)
  if (serverMs > 100 && validTcpRtt) {
    return tcpRttMs;
  }

  // Em sondagem ociosa, evita que handshake TLS/cold-socket infle o ping base
  if (!isLoaded && validTcpRtt && httpNet > tcpRttMs * 2.5) {
    return tcpRttMs;
  }

  if (validHttpNet) {
    return Math.round(httpNet * 1000) / 1000;
  }

  if (validTcpRtt) {
    return tcpRttMs;
  }

  return safeWallMs >= MIN_VALID_NETWORK_RTT_MS ? safeWallMs : 1;
}

export function isHttp1Protocol(protocol) {
  if (typeof protocol !== 'string') return false;
  const normalized = protocol.trim().toLowerCase();
  return normalized === 'http/1.1' || normalized === 'http/1.0' || normalized === 'http/1';
}

/**
 * Rastreador monotônico de bytes enviados no upload multi-stream.
 * Soma sempre `confirmedBytes + inFlightBytes` e transfere atomicamente cada bloco
 * concluído de `inFlight` para `confirmed`, evitando degraus, dupla contagem ou
 * travamentos quando o primeiro bloco termina com outros ainda em voo.
 */
export function createUploadByteTracker() {
  let confirmedBytes = 0;
  let inFlightBytes = 0;
  let recordedWatermark = 0;

  const addInFlight = (deltaBytes) => {
    if (!isValidNumber(deltaBytes) || deltaBytes === 0) return;
    inFlightBytes = Math.max(0, inFlightBytes + deltaBytes);
  };

  const confirmChunk = (chunkBytes, trackedInFlightBytes = 0) => {
    const safeChunk = isPositiveNumber(chunkBytes) ? chunkBytes : 0;
    const safeTracked = isPositiveNumber(trackedInFlightBytes) ? trackedInFlightBytes : 0;
    inFlightBytes = Math.max(0, inFlightBytes - safeTracked);
    confirmedBytes += safeChunk;
  };

  const abortChunk = (trackedInFlightBytes = 0) => {
    const safeTracked = isPositiveNumber(trackedInFlightBytes) ? trackedInFlightBytes : 0;
    inFlightBytes = Math.max(0, inFlightBytes - safeTracked);
  };

  const getEffectiveBytes = () => {
    const candidate = confirmedBytes + inFlightBytes;
    recordedWatermark = Math.max(recordedWatermark, candidate);
    return recordedWatermark;
  };

  return {
    addInFlight,
    confirmChunk,
    abortChunk,
    getEffectiveBytes,
    getTotalActivityBytes: () => confirmedBytes + inFlightBytes,
    getConfirmedBytes: () => confirmedBytes,
    getInFlightBytes: () => inFlightBytes,
    getWatermark: () => recordedWatermark
  };
}

/**
 * Consolida contadores de tentativas, sucessos, timeouts, falhas, perda percentual,
 * máximo e P95 para uma fase de sondagem de latência.
 *
 * @param {{ attempts?: number, succeeded?: number, timeouts?: number, failures?: number } | null | undefined} counters
 * @param {number[]} samplesMs
 * @returns {import('../types.js').LatencyProbePhaseStats}
 */
export function summarizeLatencyProbePhase(counters, samplesMs = []) {
  const validSamples = Array.isArray(samplesMs)
    ? samplesMs.filter((v) => isNonNegativeNumber(v))
    : [];
  const succeeded = isNonNegativeNumber(counters?.succeeded)
    ? counters.succeeded
    : validSamples.length;
  const timeouts = isNonNegativeNumber(counters?.timeouts) ? counters.timeouts : 0;
  const rawAttempts = isNonNegativeNumber(counters?.attempts) ? counters.attempts : succeeded;
  const rawFailures = isNonNegativeNumber(counters?.failures)
    ? counters.failures
    : Math.max(0, rawAttempts - succeeded);
  const failures = Math.max(timeouts, rawFailures);
  const attempts = Math.max(rawAttempts, succeeded + failures);
  const lost = Math.max(0, attempts - succeeded);
  const lossPct = attempts > 0 ? Math.round((lost / attempts) * 10_000) / 100 : 0;

  let maxMs = null;
  let p95Ms = null;
  if (validSamples.length > 0) {
    maxMs = Math.round(Math.max(...validSamples) * 1000) / 1000;
    const rawP95 = computePercentile(validSamples, 0.95);
    p95Ms = isNonNegativeNumber(rawP95) ? Math.round(rawP95 * 1000) / 1000 : maxMs;
  }

  return {
    attempts,
    succeeded,
    timeouts,
    failures,
    lossPct,
    maxMs,
    p95Ms
  };
}

export function computeRollingWindowMbps(ticks, nowRelMs, windowMs = 1000) {
  if (!Array.isArray(ticks) || ticks.length < 2) {
    return null;
  }

  const latest = ticks[ticks.length - 1];
  const effectiveNow = Math.max(
    latest.t,
    isNonNegativeNumber(nowRelMs) ? nowRelMs : latest.t
  );

  let ref = null;
  for (let i = 0; i < ticks.length - 1; i += 1) {
    if (effectiveNow - ticks[i].t <= windowMs) {
      ref = ticks[i];
      break;
    }
  }
  if (!ref) {
    ref = ticks[ticks.length - 2];
  }

  const duration = effectiveNow - ref.t;
  const dtSec = duration / 1000;
  const dBytes = latest.bytes - ref.bytes;

  if (dtSec < 0.15 || dBytes <= 0) {
    return null;
  }

  const bps = (dBytes * 8) / dtSec;
  return {
    mbps: bps / 1_000_000,
    bps,
    bytes: dBytes,
    duration
  };
}

export function selectSteadyStatePoints(points, rampDiscardMs = 1000, minSteadyCount = 4) {
  if (!Array.isArray(points) || points.length === 0) {
    return [];
  }

  const valid = points.filter((pt) => pt && isPositiveNumber(pt.bps));
  if (valid.length === 0) {
    return [];
  }

  const steady = valid.filter(
    (pt) => isNonNegativeNumber(pt.elapsedMs) && pt.elapsedMs >= rampDiscardMs
  );
  if (steady.length >= minSteadyCount) {
    return steady;
  }
  return valid;
}

/**
 * Calcula o Jitter (média das diferenças absolutas consecutivas de RTT) com
 * poda robusta leve contra um único outlier isolado (ex.: GC do navegador ou
 * scan pontual de rádio Wi-Fi) quando `N >= 6`. Se houver 2 ou mais picos/oscilações,
 * preserva todas as amostras integralmente.
 *
 * @param {number[]} latencies
 * @returns {number | null}
 */
export function computeJitterMs(latencies) {
  if (!Array.isArray(latencies)) {
    return null;
  }

  const valid = latencies.filter((v) => isNonNegativeNumber(v));
  if (valid.length < 2) {
    return null;
  }

  let working = valid;
  if (valid.length >= 6) {
    const median = computePercentile(valid, 0.5);
    if (isNonNegativeNumber(median)) {
      const absDeviations = valid.map((v) => Math.abs(v - median));
      const mad = computePercentile(absDeviations, 0.5) ?? 0;
      const outlierCutoff = Math.max(25, mad * 4);
      const outlierIndices = [];
      for (let i = 0; i < valid.length; i += 1) {
        if (Math.abs(valid[i] - median) > outlierCutoff) {
          outlierIndices.push(i);
        }
      }
      // Remove apenas quando houver exatamente 1 anomalia isolada na série inteira
      if (outlierIndices.length === 1) {
        const skipIdx = outlierIndices[0];
        working = valid.filter((_, idx) => idx !== skipIdx);
      }
    }
  }

  if (working.length < 2) {
    return null;
  }

  let sumDeltas = 0;
  for (let i = 1; i < working.length; i += 1) {
    sumDeltas += Math.abs(working[i] - working[i - 1]);
  }
  return sumDeltas / (working.length - 1);
}

function createLinkedController(...parentSignals) {
  const controller = new AbortController();
  const cleanups = [];

  for (const sig of parentSignals) {
    if (!sig) continue;
    if (sig.aborted) {
      controller.abort(sig.reason);
      return { controller, cleanup: () => {} };
    }
    const onAbort = () => controller.abort(sig.reason);
    sig.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => sig.removeEventListener('abort', onAbort));
  }

  return {
    controller,
    cleanup() {
      cleanups.forEach((fn) => fn());
    }
  };
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function delayWithSignal(ms, signal) {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise(/** @param {(value?: void) => void} resolve */ (resolve) => {
    let timer = null;
    const onAbort = () => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  });
}

function buildProbeUrl(baseUrl, params = {}) {
  const fallbackOrigin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : new URL(DEFAULT_RUNTIME_CONFIG.endpoints.down).origin;
  const url = new URL(baseUrl, fallbackOrigin);

  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null) {
      url.searchParams.set(key, String(val));
    }
  }
  url.searchParams.set('r', Math.random().toString(36).slice(2, 10));
  return url.href;
}

function getResourceTimingMeta(url) {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') {
    return { ttfbMs: null, nextHopProtocol: null };
  }
  try {
    const entries = performance.getEntriesByName(url);
    const perf = /** @type {PerformanceResourceTiming | null} */ (
      entries && entries.length > 0 ? entries[entries.length - 1] : null
    );
    if (!perf) {
      return { ttfbMs: null, nextHopProtocol: null };
    }
    const ttfbMs =
      isNonNegativeNumber(perf.requestStart) &&
      isNonNegativeNumber(perf.responseStart) &&
      perf.responseStart > perf.requestStart
        ? perf.responseStart - perf.requestStart
        : null;
    const nextHopProtocol =
      typeof perf.nextHopProtocol === 'string' && perf.nextHopProtocol.trim()
        ? perf.nextHopProtocol.trim()
        : null;
    return { ttfbMs, nextHopProtocol };
  } catch {
    return { ttfbMs: null, nextHopProtocol: null };
  }
}

export const SAFE_MAX_DOWNLOAD_CHUNK_BYTES = 50_000_000;

/**
 * Calcula dinamicamente o tamanho ideal de bloco HTTP para download conforme a vazão
 * medida, mantendo blocos reduzidos em conexões lentas/móveis e escalando até 25–50 MB
 * em links de fibra rápidos, sem ultrapassar o teto seguro do servidor.
 *
 * @param {number} mbps
 * @param {number} [currentChunkBytes]
 * @param {number} [maxDownloadBytes]
 * @returns {number}
 */
export function computeAdaptiveDownloadChunkBytes(
  mbps,
  currentChunkBytes = 2_000_000,
  maxDownloadBytes = 25_000_000
) {
  const effectiveMax = Math.min(
    SAFE_MAX_DOWNLOAD_CHUNK_BYTES,
    Math.max(500_000, Number(maxDownloadBytes) || 25_000_000)
  );
  const safeCurrent = Math.max(500_000, Number(currentChunkBytes) || 2_000_000);

  if (!isNonNegativeNumber(mbps)) {
    return Math.min(effectiveMax, safeCurrent);
  }
  if (mbps < 20) {
    return Math.min(effectiveMax, 1_000_000);
  }
  if (mbps < 50) {
    return Math.min(effectiveMax, 2_000_000);
  }
  if (mbps <= 100) {
    return Math.min(effectiveMax, Math.max(safeCurrent, 5_000_000));
  }
  if (mbps <= 300) {
    return Math.min(effectiveMax, Math.max(safeCurrent, 25_000_000));
  }
  return Math.min(effectiveMax, Math.max(safeCurrent, SAFE_MAX_DOWNLOAD_CHUNK_BYTES));
}

function clampParallelStreams(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(1, Math.min(8, Math.floor(num)));
}

export function createRunAccumulator(options = {}) {
  const measurementMode = options.measurementMode === 'commercial' ? 'commercial' : 'sustained';
  const latencyPerc = options.latencyPercentile ?? 0.5;
  const bandwidthPerc = measurementMode === 'commercial' ? 0.9 : (options.bandwidthPercentile ?? 0.5);
  const rampDiscardMs = options.rampDiscardMs ?? 1000;

  const state = {
    downloadPoints: [],
    uploadPoints: [],
    unloadedLatencies: [],
    downloadLoadedLatencies: [],
    uploadLoadedLatencies: [],
    latencyProbeCounters: {
      idle: { attempts: 0, succeeded: 0, timeouts: 0, failures: 0 },
      download: { attempts: 0, succeeded: 0, timeouts: 0, failures: 0 },
      upload: { attempts: 0, succeeded: 0, timeouts: 0, failures: 0 }
    },
    detectedProtocol: /** @type {string | null} */ (null),
    http1ConcurrencyCapped: false,
    totalDownloadBytes: 0,
    totalUploadBytes: 0,
    downloadStallsRecovered: 0,
    uploadStallsRecovered: 0,
    rateLimitDownshifts: 0
  };

  const getSteadyDownload = () =>
    selectSteadyStatePoints(state.downloadPoints, rampDiscardMs, 4);
  const getSteadyUpload = () =>
    selectSteadyStatePoints(state.uploadPoints, rampDiscardMs, 4);
  const getAllValidDownload = () =>
    selectSteadyStatePoints(state.downloadPoints, 0, 1);
  const getAllValidUpload = () =>
    selectSteadyStatePoints(state.uploadPoints, 0, 1);

  const calcLat = (arr) => (arr.length > 0 ? computePercentile(arr, latencyPerc) : undefined);
  const calcBwPercentile = (pts, perc) => {
    const bpsList = pts.map((p) => p.bps).filter((v) => isPositiveNumber(v));
    if (bpsList.length === 0) return undefined;
    return computePercentile(bpsList, perc) ?? undefined;
  };
  const calcBwPrimary = (pts) => calcBwPercentile(pts, bandwidthPerc);
  const buildLatencyProbes = () => ({
    idle: summarizeLatencyProbePhase(state.latencyProbeCounters.idle, state.unloadedLatencies),
    download: summarizeLatencyProbePhase(
      state.latencyProbeCounters.download,
      state.downloadLoadedLatencies
    ),
    upload: summarizeLatencyProbePhase(
      state.latencyProbeCounters.upload,
      state.uploadLoadedLatencies
    )
  });

  return {
    state,
    getDownloadBandwidthPoints: () =>
      measurementMode === 'commercial' ? getAllValidDownload() : getSteadyDownload(),
    getUploadBandwidthPoints: () =>
      measurementMode === 'commercial' ? getAllValidUpload() : getSteadyUpload(),
    getSteadyDownloadPoints: () => getSteadyDownload(),
    getSteadyUploadPoints: () => getSteadyUpload(),
    getUnloadedLatencyPoints: () => state.unloadedLatencies.slice(),
    getDownLoadedLatencyPoints: () => state.downloadLoadedLatencies.slice(),
    getUpLoadedLatencyPoints: () => state.uploadLoadedLatencies.slice(),
    getLatencyProbeStats: () => buildLatencyProbes(),
    getDownloadBandwidth: () => calcBwPrimary(getSteadyDownload()),
    getUploadBandwidth: () => calcBwPrimary(getSteadyUpload()),
    getSustainedDownloadBandwidth: () => calcBwPercentile(getSteadyDownload(), 0.5),
    getSustainedUploadBandwidth: () => calcBwPercentile(getSteadyUpload(), 0.5),
    getUnloadedLatency: () => calcLat(state.unloadedLatencies),
    getUnloadedJitter: () => {
      const jit = computeJitterMs(state.unloadedLatencies);
      return jit === null ? undefined : jit;
    },
    getDownLoadedLatency: () => calcLat(state.downloadLoadedLatencies),
    getDownLoadedJitter: () => {
      const jit = computeJitterMs(state.downloadLoadedLatencies);
      return jit === null ? undefined : jit;
    },
    getUpLoadedLatency: () => calcLat(state.uploadLoadedLatencies),
    getUpLoadedJitter: () => {
      const jit = computeJitterMs(state.uploadLoadedLatencies);
      return jit === null ? undefined : jit;
    },
    getTotalDownloadBytes: () => state.totalDownloadBytes,
    getTotalUploadBytes: () => state.totalUploadBytes,
    getSummary: () => ({
      engine: 'testai-multistream',
      measurementMode,
      detectedProtocol: state.detectedProtocol,
      http1ConcurrencyCapped: state.http1ConcurrencyCapped,
      latency: calcLat(state.unloadedLatencies),
      download: calcBwPrimary(getSteadyDownload()),
      upload: calcBwPrimary(getSteadyUpload()),
      sustainedDownload: calcBwPercentile(getSteadyDownload(), 0.5),
      sustainedUpload: calcBwPercentile(getSteadyUpload(), 0.5),
      downLoadedLatency: calcLat(state.downloadLoadedLatencies),
      upLoadedLatency: calcLat(state.uploadLoadedLatencies),
      latencyProbes: buildLatencyProbes(),
      downloadStallsRecovered: state.downloadStallsRecovered,
      uploadStallsRecovered: state.uploadStallsRecovered,
      rateLimitDownshifts: state.rateLimitDownshifts
    })
  };
}

export class SpeedTestService {
  constructor(callbacks = {}, deps = {}) {
    this.callbacks = callbacks;
    this.customFetch = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : null;
    this.runtimeConfig = deps.runtimeConfig || null;
    this.running = false;
    this.runId = 0;
    this.activeProfile = TEST_PROFILES.standard;
    this.startedAt = 0;
    this.lastActivityAt = 0;
    this.watchdogTimer = null;
    this.activeAbortController = null;
    this.activeResults = null;
    this.activeContext = {};
    this.payloadCache = new Map();
  }

  /**
   * @param {any} config
   */
  setRuntimeConfig(config) {
    this.runtimeConfig = config || null;
  }

  isRunning() {
    return this.running;
  }

  /**
   * @param {string} [profileId]
   * @param {{ linkType?: string, contractedMbps?: number | null, notes?: string }} [context]
   */
  start(profileId = 'standard', context = {}) {
    if (this.running) {
      this.cancel();
    }

    const caps = checkBrowserCapabilities();
    if (!caps.supported && !this.customFetch) {
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

    if (typeof performance !== 'undefined' && typeof performance.clearResourceTimings === 'function') {
      try {
        performance.clearResourceTimings();
        if (typeof performance.setResourceTimingBufferSize === 'function') {
          performance.setResourceTimingBufferSize(1000);
        }
      } catch {
        // noop
      }
    }

    const baseProfile = TEST_PROFILES[profileId] || TEST_PROFILES.standard;
    const cfg = this.runtimeConfig || getRuntimeConfig();
    const measurementMode = cfg.measurementMode === 'commercial' ? 'commercial' : 'sustained';
    const routeType = resolveRuntimeRoute(cfg);
    const baseOpts = baseProfile.options;
    const isCommercial = measurementMode === 'commercial';
    const profile = {
      ...baseProfile,
      options: {
        ...baseOpts,
        measurementMode,
        routeType,
        downloadConcurrency: isCommercial
          ? clampParallelStreams(cfg.parallelStreams?.download, baseOpts.downloadConcurrency)
          : baseOpts.downloadConcurrency,
        uploadConcurrency: isCommercial
          ? clampParallelStreams(cfg.parallelStreams?.upload, baseOpts.uploadConcurrency)
          : baseOpts.uploadConcurrency,
        rampDiscardMs: baseOpts.rampDiscardMs,
        bandwidthPercentile: isCommercial ? 0.9 : baseOpts.bandwidthPercentile,
        downloadApiUrl: cfg.endpoints.down,
        uploadApiUrl: cfg.endpoints.up,
        pingApiUrl: cfg.endpoints.ping
      }
    };
    this.activeProfile = profile;
    this.runId += 1;
    const currentRunId = this.runId;

    this.running = true;
    this.startedAt = performance.now();
    this.lastActivityAt = this.startedAt;
    this.activeContext = context || {};
    this.activeResults = createRunAccumulator(profile.options);

    const sessionAbort = new AbortController();
    this.activeAbortController = sessionAbort;

    this._startWatchdog(currentRunId, profile);

    if (typeof this.callbacks.onStart === 'function') {
      this.callbacks.onStart({
        runId: currentRunId,
        profile,
        context: this.activeContext
      });
    }

    this._runSession(currentRunId, profile, this.activeContext, sessionAbort.signal).catch(
      (error) => {
        if (currentRunId !== this.runId || !this.running || sessionAbort.signal.aborted) {
          return;
        }
        this._cleanupWatchdog();
        const partial = this.activeResults
          ? this._buildConsolidatedResult(this.activeResults, profile, this.activeContext, true)
          : null;
        this.running = false;
        this.activeAbortController = null;
        this._emitError({
          code: 'ENGINE_ERROR',
          message: error?.message || 'Falha de comunicação com os servidores de medição.',
          partialResult: partial
        });
      }
    );
  }

  cancel() {
    if (!this.running && !this.activeAbortController) {
      return;
    }

    this.runId += 1;
    this.running = false;
    this._cleanupWatchdog();

    if (this.activeAbortController) {
      try {
        this.activeAbortController.abort('cancelled');
      } catch {
        // noop
      }
      this.activeAbortController = null;
    }
    this.activeResults = null;

    if (typeof this.callbacks.onCancel === 'function') {
      this.callbacks.onCancel();
    }
  }

  _fetch(url, init) {
    return this.customFetch ? this.customFetch(url, init) : fetch(url, init);
  }

  _getUploadPayload(sizeBytes) {
    const key = Math.max(1024, Math.floor(sizeBytes));
    if (!this.payloadCache.has(key)) {
      if (this.payloadCache.size >= 8) {
        const firstKey = this.payloadCache.keys().next().value;
        this.payloadCache.delete(firstKey);
      }
      this.payloadCache.set(key, new Uint8Array(key));
    }
    return this.payloadCache.get(key);
  }

  _isActiveRun(runId, signal) {
    return runId === this.runId && this.running && !signal?.aborted;
  }

  _emitProgressSnapshot(runId, phase, progressPercent, accumulator, context, signal) {
    if (!this._isActiveRun(runId, signal)) return;
    if (typeof this.callbacks.onProgress !== 'function') return;

    this.callbacks.onProgress({
      runId,
      phase,
      progressPercent: clamp(Math.round(progressPercent), 2, 96),
      snapshot: this._extractSnapshot(accumulator, false),
      context
    });
  }

  _startWatchdog(currentRunId, profile) {
    this._cleanupWatchdog();
    this.watchdogTimer = globalThis.setInterval(() => {
      if (currentRunId !== this.runId || !this.running) {
        this._cleanupWatchdog();
        return;
      }

      const now = performance.now();
      const elapsedTotal = now - this.startedAt;
      const elapsedIdle = now - this.lastActivityAt;

      if (elapsedTotal > profile.timeoutMs || elapsedIdle > profile.inactivityTimeoutMs) {
        const partial = this.activeResults
          ? this._buildConsolidatedResult(
              this.activeResults,
              profile,
              this.activeContext,
              true
            )
          : null;

        this.runId += 1;
        this.running = false;
        this._cleanupWatchdog();

        if (this.activeAbortController) {
          try {
            this.activeAbortController.abort('timeout');
          } catch {
            // noop
          }
          this.activeAbortController = null;
        }
        this.activeResults = null;

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

  async _probeLatencyOnce({ urlBase, during, pingTimeoutMs, signal, isLoaded, onOutcome }) {
    if (signal?.aborted) {
      onOutcome?.({ status: 'aborted', nextHopProtocol: null });
      return null;
    }

    const url = buildProbeUrl(urlBase, { bytes: 0, during });
    const linked = createLinkedController(signal);
    let timedOut = false;
    const reqTimer = globalThis.setTimeout(() => {
      timedOut = true;
      linked.controller.abort('ping-timeout');
    }, pingTimeoutMs);
    const start = performance.now();

    try {
      const res = await this._fetch(url, {
        cache: 'no-store',
        signal: linked.controller.signal
      });
      const wallMs = performance.now() - start;
      await res?.text?.().catch(() => {});
      if (signal?.aborted) {
        onOutcome?.({ status: 'aborted', nextHopProtocol: null });
        return null;
      }
      if (!res?.ok) {
        onOutcome?.({ status: 'failed', nextHopProtocol: null });
        return null;
      }

      const serverTimingHeader = res.headers?.get?.('server-timing') || '';
      const rawRouteHeader = (res.headers?.get?.('x-testai-route') || '').trim().toLowerCase();
      const headerRoute = rawRouteHeader === 'on-net' ? 'on-net' : null;
      const resourceMeta = getResourceTimingMeta(url);
      const rttMs = resolveNetworkRttMs({
        wallMs,
        resourceTtfbMs: resourceMeta.ttfbMs,
        serverTimingHeader,
        isLoaded
      });
      onOutcome?.({
        status: 'ok',
        nextHopProtocol: resourceMeta.nextHopProtocol,
        headerRoute
      });
      return rttMs;
    } catch {
      if (signal?.aborted) {
        onOutcome?.({ status: 'aborted', nextHopProtocol: null });
      } else if (timedOut) {
        onOutcome?.({ status: 'timeout', nextHopProtocol: null });
      } else {
        onOutcome?.({ status: 'failed', nextHopProtocol: null });
      }
      return null;
    } finally {
      clearTimeout(reqTimer);
      linked.cleanup();
    }
  }

  _applyDetectedProtocolGuard(profile, accumulator, nextHopProtocol) {
    if (!nextHopProtocol || !accumulator?.state) return;
    if (!accumulator.state.detectedProtocol) {
      accumulator.state.detectedProtocol = nextHopProtocol;
    }
    if (isHttp1Protocol(nextHopProtocol)) {
      const dlCap = Math.min(
        profile.options.downloadConcurrency || MAX_HTTP1_SAFE_STREAMS,
        MAX_HTTP1_SAFE_STREAMS
      );
      const ulCap = Math.min(
        profile.options.uploadConcurrency || MAX_HTTP1_SAFE_STREAMS,
        MAX_HTTP1_SAFE_STREAMS
      );
      if (
        dlCap < (profile.options.downloadConcurrency || 0) ||
        ulCap < (profile.options.uploadConcurrency || 0)
      ) {
        accumulator.state.http1ConcurrencyCapped = true;
      }
      profile.options.downloadConcurrency = dlCap;
      profile.options.uploadConcurrency = ulCap;
    }
  }

  _recordProbeOutcome(counters, rttMs, reportedOutcome, signal) {
    if (!counters) return;
    if (reportedOutcome === 'aborted' || (rttMs === null && signal?.aborted)) {
      return;
    }
    counters.attempts += 1;
    if (rttMs !== null) {
      counters.succeeded += 1;
      return;
    }
    counters.failures += 1;
    // Se _probeLatencyOnce foi sobrescrito em mock retornando null sem relatar status, contabiliza como timeout/falha
    if (reportedOutcome === 'timeout' || reportedOutcome === null) {
      counters.timeouts += 1;
    }
  }

  async _runLatencyPhase(runId, profile, accumulator, context, signal) {
    const opts = profile.options;
    const totalNeeded = opts.idlePingCount || 10;
    const maxBudgetMs = opts.maxIdleLatencyMs || 2000;
    const pingTimeoutMs = opts.pingTimeoutMs || 1200;
    const baseIntervalMs = isNonNegativeNumber(opts.idlePingIntervalMs)
      ? opts.idlePingIntervalMs
      : DEFAULT_IDLE_PING_INTERVAL_MS;
    const budgetCapIntervalMs = Math.floor(maxBudgetMs / Math.max(2, totalNeeded * 2));
    const interProbeDelayMs = Math.max(0, Math.min(baseIntervalMs, budgetCapIntervalMs));
    const phaseStart = performance.now();
    const hardLimitMs = maxBudgetMs * 1.5;

    // 1 sonda de aquecimento TLS/rota (descartada das estatísticas, mas detecta nextHopProtocol e X-TestAi-Route)
    let warmupProtocol = null;
    await this._probeLatencyOnce({
      urlBase: opts.pingApiUrl || opts.downloadApiUrl,
      during: 'warmup',
      pingTimeoutMs,
      signal,
      isLoaded: false,
      onOutcome: (meta) => {
        warmupProtocol = meta?.nextHopProtocol || null;
        if (meta?.headerRoute === 'on-net') {
          profile.options.routeType = 'on-net';
        }
      }
    });
    this._applyDetectedProtocolGuard(profile, accumulator, warmupProtocol);

    for (let i = 0; i < totalNeeded + 2; i += 1) {
      if (!this._isActiveRun(runId, signal)) return;

      if (i > 0 && interProbeDelayMs > 0) {
        const remainingBudget = maxBudgetMs - (performance.now() - phaseStart);
        if (remainingBudget > interProbeDelayMs) {
          await delayWithSignal(interProbeDelayMs, signal);
        }
        if (!this._isActiveRun(runId, signal)) return;
      }

      const elapsed = performance.now() - phaseStart;
      const gotEnough = accumulator.state.unloadedLatencies.length >= totalNeeded;
      const hitSoftDeadline =
        elapsed >= maxBudgetMs && accumulator.state.unloadedLatencies.length >= 5;
      if (gotEnough || hitSoftDeadline || elapsed >= hardLimitMs) {
        break;
      }

      /** @type {'ok' | 'timeout' | 'failed' | 'aborted' | null} */
      let probeOutcome = null;
      let probeProtocol = null;
      const rttMs = await this._probeLatencyOnce({
        urlBase: opts.pingApiUrl || opts.downloadApiUrl,
        during: 'idle',
        pingTimeoutMs,
        signal,
        isLoaded: false,
        onOutcome: (meta) => {
          probeOutcome = meta?.status || null;
          probeProtocol = meta?.nextHopProtocol || null;
          if (meta?.headerRoute === 'on-net') {
            profile.options.routeType = 'on-net';
          }
        }
      });

      if (!accumulator.state.detectedProtocol && probeProtocol) {
        this._applyDetectedProtocolGuard(profile, accumulator, probeProtocol);
      }

      this._recordProbeOutcome(
        accumulator.state.latencyProbeCounters.idle,
        rttMs,
        probeOutcome,
        signal
      );

      if (rttMs !== null) {
        this.lastActivityAt = performance.now();
        accumulator.state.unloadedLatencies.push(rttMs);
        const pct = 4 + (accumulator.state.unloadedLatencies.length / totalNeeded) * 10;
        this._emitProgressSnapshot(runId, 'latency', pct, accumulator, context, signal);
      }
    }
  }

  async _runLoadedLatencyLoop({
    urlBase,
    during,
    throttleMs,
    pingTimeoutMs,
    stopAt,
    signal,
    counters,
    onSample
  }) {
    while (!signal?.aborted && performance.now() < stopAt) {
      await delayWithSignal(throttleMs, signal);
      if (signal?.aborted || performance.now() >= stopAt) break;

      /** @type {'ok' | 'timeout' | 'failed' | 'aborted' | null} */
      let probeOutcome = null;
      const rttMs = await this._probeLatencyOnce({
        urlBase,
        during,
        pingTimeoutMs,
        signal,
        isLoaded: true,
        onOutcome: (meta) => {
          probeOutcome = meta?.status || null;
        }
      });
      this._recordProbeOutcome(counters, rttMs, probeOutcome, signal);
      if (rttMs !== null && !signal?.aborted) {
        onSample(rttMs);
      }
    }
  }

  async _downloadChunk({
    urlBase,
    workerId,
    chunkBytes,
    stallTimeoutMs,
    stopAt,
    phaseSignal,
    onBytesReceived
  }) {
    const url = buildProbeUrl(urlBase, { bytes: chunkBytes, w: workerId });
    const linked = createLinkedController(phaseSignal);
    let lastProgressAt = performance.now();
    let stalled = false;
    let abortedByDeadline = false;

    const wdTimer = globalThis.setInterval(() => {
      const now = performance.now();
      if (now >= stopAt || phaseSignal.aborted) {
        abortedByDeadline = true;
        linked.controller.abort('deadline');
        return;
      }
      if (now - lastProgressAt > stallTimeoutMs) {
        stalled = true;
        linked.controller.abort('stall');
      }
    }, 200);

    try {
      const res = await this._fetch(url, {
        cache: 'no-store',
        signal: linked.controller.signal
      });

      if (res.status === 429 || res.status === 403) {
        return { rateLimited: true };
      }
      if (!res.ok) {
        return { httpError: res.status };
      }

      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          lastProgressAt = performance.now();
          if (value && value.byteLength > 0) {
            onBytesReceived(value.byteLength);
          }
          if (lastProgressAt >= stopAt || phaseSignal.aborted) {
            abortedByDeadline = true;
            linked.controller.abort('deadline');
            break;
          }
        }
        return { ok: true, abortedByDeadline };
      }

      const bodyData =
        typeof res.arrayBuffer === 'function' ? await res.arrayBuffer() : await res.text?.();
      const len = bodyData?.byteLength ?? (typeof bodyData === 'string' ? bodyData.length : 0);
      if (len > 0) {
        onBytesReceived(len);
      }
      return { ok: true };
    } catch {
      if (stalled) return { stalled: true };
      if (abortedByDeadline || phaseSignal.aborted) return { abortedByDeadline: true };
      return { networkError: true };
    } finally {
      clearInterval(wdTimer);
      linked.cleanup();
    }
  }

  async _runDownloadPhase(runId, profile, accumulator, context, sessionSignal) {
    const opts = profile.options;
    const phaseController = new AbortController();
    const phaseSignal = phaseController.signal;
    const stopSessionRelay = () => phaseController.abort(sessionSignal.reason);
    sessionSignal.addEventListener('abort', stopSessionRelay, { once: true });

    const phaseStart = performance.now();
    const stopAt = phaseStart + opts.downloadDurationMs;
    const ticks = [{ t: 0, bytes: 0 }];
    let currentChunkBytes = opts.initialDownloadBytes || 2_000_000;
    let totalBytes = 0;
    let lastObservedBytes = 0;

    this._emitProgressSnapshot(runId, 'download', 15, accumulator, context, sessionSignal);

    const sampler = globalThis.setInterval(() => {
      if (!this._isActiveRun(runId, phaseSignal)) return;
      const now = performance.now();
      const relMs = now - phaseStart;
      ticks.push({ t: relMs, bytes: totalBytes });

      if (totalBytes > lastObservedBytes) {
        this.lastActivityAt = now;
        lastObservedBytes = totalBytes;
      }

      const sample = computeRollingWindowMbps(ticks, relMs, opts.rollingWindowMs || 1000);
      if (sample) {
        accumulator.state.downloadPoints.push({
          ...sample,
          elapsedMs: relMs,
          measTime: Math.round(relMs)
        });
        if (accumulator.state.rateLimitDownshifts === 0) {
          currentChunkBytes = computeAdaptiveDownloadChunkBytes(
            sample.mbps,
            currentChunkBytes,
            opts.maxDownloadBytes
          );
        }
      }

      const progressRatio = clamp(relMs / opts.downloadDurationMs, 0, 1);
      this._emitProgressSnapshot(
        runId,
        'download',
        15 + progressRatio * 40,
        accumulator,
        context,
        sessionSignal
      );
    }, opts.sampleIntervalMs || 250);

    const downloadWorker = async (workerId) => {
      while (!phaseSignal.aborted && performance.now() < stopAt) {
        const result = await this._downloadChunk({
          urlBase: opts.downloadApiUrl,
          workerId,
          chunkBytes: currentChunkBytes,
          stallTimeoutMs: opts.downloadStallTimeoutMs || 2000,
          stopAt,
          phaseSignal,
          onBytesReceived: (len) => {
            totalBytes += len;
            accumulator.state.totalDownloadBytes += len;
          }
        });

        if (result.rateLimited) {
          accumulator.state.rateLimitDownshifts += 1;
          currentChunkBytes = Math.max(500_000, Math.floor(currentChunkBytes / 2));
          await delayWithSignal(250, phaseSignal);
        } else if (result.stalled) {
          accumulator.state.downloadStallsRecovered += 1;
        } else if (result.httpError || result.networkError) {
          await delayWithSignal(180, phaseSignal);
        }
      }
    };

    const tasks = Array.from({ length: opts.downloadConcurrency || 4 }, (_, idx) =>
      downloadWorker(idx)
    );

    if (opts.measureDownloadLoadedLatency) {
      tasks.push(
        this._runLoadedLatencyLoop({
          urlBase: opts.pingApiUrl || opts.downloadApiUrl,
          during: 'download',
          throttleMs: opts.loadedLatencyThrottle || 400,
          pingTimeoutMs: Math.max(opts.pingTimeoutMs || 1200, 1800),
          stopAt,
          signal: phaseSignal,
          counters: accumulator.state.latencyProbeCounters.download,
          onSample: (rttMs) => accumulator.state.downloadLoadedLatencies.push(rttMs)
        })
      );
    }

    try {
      await Promise.all(tasks);
    } finally {
      clearInterval(sampler);
      sessionSignal.removeEventListener('abort', stopSessionRelay);
      phaseController.abort('phase-done');
    }

    const endRelMs = Math.max(150, performance.now() - phaseStart);
    ticks.push({ t: endRelMs, bytes: totalBytes });
    const finalSample = computeRollingWindowMbps(ticks, endRelMs, opts.rollingWindowMs || 1000);
    if (finalSample && totalBytes > lastObservedBytes) {
      this.lastActivityAt = performance.now();
      accumulator.state.downloadPoints.push({
        ...finalSample,
        elapsedMs: endRelMs,
        measTime: Math.round(endRelMs)
      });
    }
  }

  _uploadChunkWithXhr({
    url,
    payload,
    stallTimeoutMs,
    stopAt,
    phaseSignal,
    activeXhrs,
    onInFlightChange,
    onChunkSettled
  }) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      const chunkByteLength = payload?.byteLength || 0;
      activeXhrs.add(xhr);
      let settled = false;
      let lastLoaded = 0;
      let lastProgressAt = performance.now();
      let stalled = false;
      let abortedByDeadline = false;

      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearInterval(wdTimer);
        phaseSignal.removeEventListener('abort', onAbort);
        activeXhrs.delete(xhr);
        const trackedBytes = lastLoaded;
        lastLoaded = 0;
        if (typeof onChunkSettled === 'function') {
          onChunkSettled(Boolean(outcome?.ok), chunkByteLength, trackedBytes);
        } else if (trackedBytes > 0) {
          onInFlightChange?.(-trackedBytes);
        }
        resolve(outcome);
      };

      const onAbort = () => {
        abortedByDeadline = true;
        try {
          xhr.abort();
        } catch {
          // noop
        }
        finish({ abortedByDeadline: true });
      };

      if (phaseSignal.aborted) {
        finish({ abortedByDeadline: true });
        return;
      }
      phaseSignal.addEventListener('abort', onAbort, { once: true });

      const wdTimer = globalThis.setInterval(() => {
        const now = performance.now();
        if (now >= stopAt || phaseSignal.aborted) {
          abortedByDeadline = true;
          try {
            xhr.abort();
          } catch {
            // noop
          }
          finish({ abortedByDeadline: true });
          return;
        }
        if (now - lastProgressAt > stallTimeoutMs) {
          stalled = true;
          try {
            xhr.abort();
          } catch {
            // noop
          }
          finish({ stalled: true });
        }
      }, 200);

      xhr.open('POST', url, true);

      xhr.upload.onprogress = (evt) => {
        lastProgressAt = performance.now();
        const rawLoaded = Number(evt?.loaded) || 0;
        const loaded =
          chunkByteLength > 0 ? clamp(rawLoaded, 0, chunkByteLength) : Math.max(0, rawLoaded);
        const delta = Math.max(0, loaded - lastLoaded);
        if (delta > 0) {
          lastLoaded = loaded;
          onInFlightChange?.(delta);
        }
      };

      xhr.onload = () => {
        if (xhr.status === 429 || xhr.status === 403) {
          finish({ rateLimited: true });
        } else if (xhr.status >= 200 && xhr.status < 300) {
          finish({ ok: true });
        } else {
          finish({ httpError: xhr.status });
        }
      };

      xhr.onerror = () => finish({ networkError: true });
      xhr.onabort = () => {
        if (stalled) finish({ stalled: true });
        else if (abortedByDeadline || phaseSignal.aborted) finish({ abortedByDeadline: true });
        else finish({ networkError: true });
      };

      try {
        xhr.send(payload);
      } catch {
        finish({ networkError: true });
      }
    });
  }

  async _uploadChunkWithFetch({ url, payload, stallTimeoutMs, stopAt, phaseSignal }) {
    const linked = createLinkedController(phaseSignal);
    let timedOut = false;
    let abortedByDeadline = false;
    const remMs = Math.max(100, stopAt - performance.now() + 250);

    const stallTimer = globalThis.setTimeout(() => {
      timedOut = true;
      linked.controller.abort('upload-stall');
    }, stallTimeoutMs);

    const stopTimer = globalThis.setTimeout(() => {
      abortedByDeadline = true;
      linked.controller.abort('upload-deadline');
    }, remMs);

    try {
      const res = await this._fetch(url, {
        method: 'POST',
        body: payload,
        cache: 'no-store',
        signal: linked.controller.signal
      });
      await res?.text?.().catch(() => {});
      if (res.status === 429 || res.status === 403) {
        return { rateLimited: true };
      }
      if (!res.ok) {
        return { httpError: res.status };
      }
      return { ok: true };
    } catch {
      if (timedOut) return { stalled: true };
      if (abortedByDeadline || phaseSignal.aborted) return { abortedByDeadline: true };
      return { networkError: true };
    } finally {
      clearTimeout(stallTimer);
      clearTimeout(stopTimer);
      linked.cleanup();
    }
  }

  async _runUploadPhase(runId, profile, accumulator, context, sessionSignal) {
    const opts = profile.options;
    const phaseController = new AbortController();
    const phaseSignal = phaseController.signal;
    const activeXhrs = new Set();

    const stopSessionRelay = () => {
      phaseController.abort(sessionSignal.reason);
      activeXhrs.forEach((xhr) => {
        try {
          xhr.abort();
        } catch {
          // noop
        }
      });
    };
    sessionSignal.addEventListener('abort', stopSessionRelay, { once: true });

    const useXhr = typeof XMLHttpRequest === 'function' && !this.customFetch;
    const phaseStart = performance.now();
    const stopAt = phaseStart + opts.uploadDurationMs;
    const ticks = [{ t: 0, bytes: 0 }];
    const byteTracker = createUploadByteTracker();
    let currentChunkBytes = opts.initialUploadBytes || 524_288;
    let lastActivityMarker = 0;

    this._emitProgressSnapshot(runId, 'upload', 56, accumulator, context, sessionSignal);

    const adaptUploadChunkSize = (mbps, relMs) => {
      if (accumulator.state.rateLimitDownshifts > 0) return;
      const maxCap = opts.maxUploadBytes || 4_000_000;
      if (byteTracker.getConfirmedBytes() === 0 && relMs >= 1200) {
        currentChunkBytes = 131_072;
        return;
      }
      if (mbps > 160) {
        currentChunkBytes = Math.min(maxCap, 4_000_000);
      } else if (mbps > 55) {
        currentChunkBytes = Math.min(maxCap, 2_000_000);
      } else if (mbps > 15) {
        currentChunkBytes = Math.min(maxCap, 1_000_000);
      } else {
        currentChunkBytes = Math.min(maxCap, 262_144);
      }
    };

    const sampler = globalThis.setInterval(() => {
      if (!this._isActiveRun(runId, phaseSignal)) return;
      const now = performance.now();
      const relMs = now - phaseStart;
      const effectiveBytes = byteTracker.getEffectiveBytes();
      ticks.push({ t: relMs, bytes: effectiveBytes });

      const activityNow = byteTracker.getTotalActivityBytes();
      if (activityNow > lastActivityMarker) {
        this.lastActivityAt = now;
        lastActivityMarker = activityNow;
      }

      const sample = computeRollingWindowMbps(ticks, relMs, opts.rollingWindowMs || 1000);
      if (sample) {
        accumulator.state.uploadPoints.push({
          ...sample,
          elapsedMs: relMs,
          measTime: Math.round(relMs)
        });
        adaptUploadChunkSize(sample.mbps, relMs);
      } else if (
        byteTracker.getConfirmedBytes() === 0 &&
        relMs >= 1200 &&
        accumulator.state.rateLimitDownshifts === 0
      ) {
        currentChunkBytes = 131_072;
      }

      const progressRatio = clamp(relMs / opts.uploadDurationMs, 0, 1);
      this._emitProgressSnapshot(
        runId,
        'upload',
        56 + progressRatio * 40,
        accumulator,
        context,
        sessionSignal
      );
    }, opts.sampleIntervalMs || 250);

    const uploadWorker = async (workerId) => {
      if (workerId >= 2 && opts.measurementMode !== 'commercial') {
        const staggerStart = performance.now();
        while (
          !phaseSignal.aborted &&
          byteTracker.getConfirmedBytes() === 0 &&
          performance.now() - staggerStart < 450 &&
          performance.now() < stopAt
        ) {
          await delayWithSignal(75, phaseSignal);
        }
      }

      while (!phaseSignal.aborted && performance.now() < stopAt) {
        const rem = stopAt - performance.now();
        if (rem < 150) break;

        const chunkSize = currentChunkBytes;
        const payload = this._getUploadPayload(chunkSize);
        const url = buildProbeUrl(opts.uploadApiUrl, { w: workerId });

        const result = useXhr
          ? await this._uploadChunkWithXhr({
              url,
              payload,
              stallTimeoutMs: opts.uploadStallTimeoutMs || 2800,
              stopAt,
              phaseSignal,
              activeXhrs,
              onInFlightChange: (delta) => {
                byteTracker.addInFlight(delta);
                if (delta > 0) {
                  this.lastActivityAt = performance.now();
                }
              },
              onChunkSettled: (isOk, totalChunkBytes, trackedInFlightBytes) => {
                if (isOk) {
                  byteTracker.confirmChunk(totalChunkBytes, trackedInFlightBytes);
                } else {
                  byteTracker.abortChunk(trackedInFlightBytes);
                }
              }
            })
          : await this._uploadChunkWithFetch({
              url,
              payload,
              stallTimeoutMs: opts.uploadStallTimeoutMs || 2800,
              stopAt,
              phaseSignal
            });

        if (result.ok) {
          if (!useXhr) {
            byteTracker.confirmChunk(chunkSize, 0);
          }
          accumulator.state.totalUploadBytes += chunkSize;
          this.lastActivityAt = performance.now();
        } else if (result.rateLimited) {
          accumulator.state.rateLimitDownshifts += 1;
          currentChunkBytes = Math.max(262_144, Math.floor(currentChunkBytes / 2));
          await delayWithSignal(250, phaseSignal);
        } else if (result.stalled) {
          accumulator.state.uploadStallsRecovered += 1;
        } else if (result.httpError || result.networkError) {
          await delayWithSignal(180, phaseSignal);
        }
      }
    };

    const tasks = Array.from({ length: opts.uploadConcurrency || 4 }, (_, idx) =>
      uploadWorker(idx)
    );

    if (opts.measureUploadLoadedLatency) {
      tasks.push(
        this._runLoadedLatencyLoop({
          urlBase: opts.pingApiUrl || opts.downloadApiUrl,
          during: 'upload',
          throttleMs: opts.loadedLatencyThrottle || 400,
          pingTimeoutMs: Math.max(opts.pingTimeoutMs || 1200, 1800),
          stopAt,
          signal: phaseSignal,
          counters: accumulator.state.latencyProbeCounters.upload,
          onSample: (rttMs) => accumulator.state.uploadLoadedLatencies.push(rttMs)
        })
      );
    }

    try {
      await Promise.all(tasks);
    } finally {
      clearInterval(sampler);
      sessionSignal.removeEventListener('abort', stopSessionRelay);
      activeXhrs.forEach((xhr) => {
        try {
          xhr.abort();
        } catch {
          // noop
        }
      });
      phaseController.abort('phase-done');
    }

    const endRelMs = Math.max(150, performance.now() - phaseStart);
    const finalEffectiveBytes = byteTracker.getEffectiveBytes();
    ticks.push({ t: endRelMs, bytes: finalEffectiveBytes });
    const finalSample = computeRollingWindowMbps(ticks, endRelMs, opts.rollingWindowMs || 1000);
    if (finalSample && finalEffectiveBytes > lastActivityMarker) {
      this.lastActivityAt = performance.now();
      accumulator.state.uploadPoints.push({
        ...finalSample,
        elapsedMs: endRelMs,
        measTime: Math.round(endRelMs)
      });
    }
  }

  async _runSession(currentRunId, profile, context, sessionSignal) {
    const accumulator = this.activeResults;

    await this._runLatencyPhase(currentRunId, profile, accumulator, context, sessionSignal);
    if (!this._isActiveRun(currentRunId, sessionSignal)) return;

    await this._runDownloadPhase(currentRunId, profile, accumulator, context, sessionSignal);
    if (!this._isActiveRun(currentRunId, sessionSignal)) return;

    await this._runUploadPhase(currentRunId, profile, accumulator, context, sessionSignal);
    if (!this._isActiveRun(currentRunId, sessionSignal)) return;

    this._cleanupWatchdog();
    this.running = false;
    this.activeAbortController = null;
    this.activeResults = null;

    const dlCount = accumulator.getDownloadBandwidthPoints().length;
    const ulCount = accumulator.getUploadBandwidthPoints().length;
    const pingCount = accumulator.getUnloadedLatencyPoints().length;

    if (dlCount === 0 || ulCount === 0) {
      const hasAnyData = dlCount > 0 || ulCount > 0 || pingCount > 0;
      const partial = hasAnyData
        ? this._buildConsolidatedResult(accumulator, profile, context, true)
        : null;
      const message =
        dlCount > 0 && ulCount === 0
          ? 'O envio (upload) deste dispositivo/rede local para a internet não retornou amostras suficientes. Verifique sinal Wi-Fi, firewall ou VPN antes de concluir falha no provedor.'
          : 'Não foi possível concluir todas as fases essenciais de medição contra o servidor de teste.';
      this._emitError({
        code: 'ENGINE_ERROR',
        message,
        partialResult: partial
      });
      return;
    }

    const consolidated = this._buildConsolidatedResult(accumulator, profile, context, false);
    if (typeof this.callbacks.onFinish === 'function') {
      this.callbacks.onFinish(consolidated);
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

  /**
   * @param {Record<string, any>} results
   * @param {any} profile
   * @param {{ linkType?: string, contractedMbps?: number | null, notes?: string }} context
   * @param {boolean} incomplete
   * @returns {import('../types.js').SpeedTestResult}
   */
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

    const rampDiscardMs = isNonNegativeNumber(profile?.options?.rampDiscardMs)
      ? profile.options.rampDiscardMs
      : 1000;

    let steadyDlPoints = [];
    let steadyUlPoints = [];
    try {
      steadyDlPoints =
        typeof results.getSteadyDownloadPoints === 'function'
          ? sanitizeBandwidthPoints(results.getSteadyDownloadPoints())
          : selectSteadyStatePoints(dlPoints, rampDiscardMs, 4);
    } catch {
      steadyDlPoints = selectSteadyStatePoints(dlPoints, rampDiscardMs, 4);
    }

    try {
      steadyUlPoints =
        typeof results.getSteadyUploadPoints === 'function'
          ? sanitizeBandwidthPoints(results.getSteadyUploadPoints())
          : selectSteadyStatePoints(ulPoints, rampDiscardMs, 4);
    } catch {
      steadyUlPoints = selectSteadyStatePoints(ulPoints, rampDiscardMs, 4);
    }

    const idleLatValues = idleLatPoints.map((p) => p.ms);
    const dlLatValues = dlLatPoints.map((p) => p.ms);
    const ulLatValues = ulLatPoints.map((p) => p.ms);

    let latencyProbes = null;
    try {
      if (typeof results.getLatencyProbeStats === 'function') {
        latencyProbes = results.getLatencyProbeStats();
      }
    } catch {
      latencyProbes = null;
    }
    if (!latencyProbes) {
      latencyProbes = {
        idle: summarizeLatencyProbePhase(null, idleLatValues),
        download: summarizeLatencyProbePhase(null, dlLatValues),
        upload: summarizeLatencyProbePhase(null, ulLatValues)
      };
    }

    const downloadLatencyDelta = calculateLatencyDelta(
      snapshot.metrics.ping.value,
      snapshot.metrics.downloadLatency.value
    );

    const uploadLatencyDelta = calculateLatencyDelta(
      snapshot.metrics.ping.value,
      snapshot.metrics.uploadLatency.value
    );

    const totalDownloadBytes =
      typeof results.getTotalDownloadBytes === 'function'
        ? results.getTotalDownloadBytes()
        : dlPoints.reduce((acc, p) => acc + (p.bytes || 0), 0);
    const totalUploadBytes =
      typeof results.getTotalUploadBytes === 'function'
        ? results.getTotalUploadBytes()
        : ulPoints.reduce((acc, p) => acc + (p.bytes || 0), 0);

    const measurementMode =
      profile?.options?.measurementMode === 'commercial' ? 'commercial' : 'sustained';
    const routeType =
      profile?.options?.routeType === 'on-net' ? 'on-net' : 'off-net-fallback';

    const consolidatedMetrics = {
      ...snapshot.metrics,
      downloadLatencyDelta: resolveMetric(downloadLatencyDelta, 'ms', false),
      uploadLatencyDelta: resolveMetric(uploadLatencyDelta, 'ms', false)
    };
    const loadedSpikes = analyzeLoadedLatencySpikes({
      metrics: consolidatedMetrics,
      series: snapshot.series
    });

    return {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      incomplete,
      durationMs,
      measurementMode,
      routeType,
      parallelStreams: {
        download: profile?.options?.downloadConcurrency ?? 4,
        upload: profile?.options?.uploadConcurrency ?? 4
      },
      profile: {
        id: profile.id,
        label: profile.label
      },
      context: {
        linkType: context.linkType || 'nao-informado',
        contractedMbps:
          isNonNegativeNumber(context.contractedMbps) && context.contractedMbps > 0
            ? context.contractedMbps
            : null,
        notes: typeof context.notes === 'string' ? context.notes.trim() : ''
      },
      metrics: consolidatedMetrics,
      stats: {
        download: computeStats(steadyDlPoints.map((p) => p.mbps)),
        upload: computeStats(steadyUlPoints.map((p) => p.mbps)),
        unloadedLatency: computeStats(idleLatValues),
        downloadLatency: computeStats(dlLatValues),
        uploadLatency: computeStats(ulLatValues)
      },
      transfer: {
        totalDownloadBytes,
        totalUploadBytes,
        totalBytes: totalDownloadBytes + totalUploadBytes
      },
      series: snapshot.series,
      loadedSpikes,
      latencyProbes,
      rawSummary: summary
    };
  }
}
