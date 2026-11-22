/**
 * Motor de medição multi-stream resiliente do TestAi (estilo Fast.com)
 * contra Cloudflare Edge (https://speed.cloudflare.com/__down e /__up).
 * Gerencia múltiplos fluxos paralelos em streaming, janela deslizante de 1s,
 * recuperação silenciosa de stalls individuais, downshift automático em 429/403
 * e extração de RTT real via Resource Timing + Server-Timing (cfL4 rtt).
 */

import { TEST_PROFILES } from '../config/speedtest.config.js';
import {
  checkBrowserCapabilities,
  clamp,
  isNonNegativeNumber,
  isPositiveNumber,
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
  const safeWallMs = isNonNegativeNumber(wallMs) ? wallMs : 1;
  const baseTtfb =
    isNonNegativeNumber(resourceTtfbMs) && resourceTtfbMs > 0 ? resourceTtfbMs : safeWallMs;

  const { serverMs, tcpRttMs } = parseServerTiming(serverTimingHeader);
  const httpNet = baseTtfb - serverMs;
  const validTcpRtt = isNonNegativeNumber(tcpRttMs) && tcpRttMs >= 0.5 && tcpRttMs <= 2000;

  // Protege o RTT contra picos artificiais de processamento no Worker da borda (cfSpeedWorker)
  if (serverMs > 100 && validTcpRtt) {
    return tcpRttMs;
  }

  // Em sondagem ociosa, evita que handshake TLS/cold-socket infle o ping base
  if (!isLoaded && validTcpRtt && httpNet > tcpRttMs * 2.5) {
    return tcpRttMs;
  }

  if (isNonNegativeNumber(httpNet) && httpNet >= 0.5 && httpNet <= 2000) {
    return httpNet;
  }

  if (validTcpRtt) {
    return tcpRttMs;
  }

  return Math.max(1, safeWallMs);
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

export function computeJitterMs(latencies) {
  if (!Array.isArray(latencies) || latencies.length < 2) {
    return null;
  }

  let sumDeltas = 0;
  for (let i = 1; i < latencies.length; i += 1) {
    sumDeltas += Math.abs(latencies[i] - latencies[i - 1]);
  }
  return sumDeltas / (latencies.length - 1);
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
      : 'https://speed.cloudflare.com';
  const url = new URL(baseUrl, fallbackOrigin);

  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null) {
      url.searchParams.set(key, String(val));
    }
  }
  url.searchParams.set('r', Math.random().toString(36).slice(2, 10));
  return url.href;
}

function getResourceTtfbMs(url) {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') {
    return null;
  }
  try {
    const entries = performance.getEntriesByName(url);
    const perf = /** @type {PerformanceResourceTiming | null} */ (
      entries && entries.length > 0 ? entries[entries.length - 1] : null
    );
    if (
      perf &&
      isNonNegativeNumber(perf.requestStart) &&
      isNonNegativeNumber(perf.responseStart) &&
      perf.responseStart > perf.requestStart
    ) {
      return perf.responseStart - perf.requestStart;
    }
  } catch {
    // noop
  }
  return null;
}

export function createRunAccumulator(options = {}) {
  const latencyPerc = options.latencyPercentile ?? 0.5;
  const rampDiscardMs = options.rampDiscardMs ?? 1000;

  const state = {
    downloadPoints: [],
    uploadPoints: [],
    unloadedLatencies: [],
    downloadLoadedLatencies: [],
    uploadLoadedLatencies: [],
    totalDownloadBytes: 0,
    totalUploadBytes: 0,
    downloadStallsRecovered: 0,
    uploadStallsRecovered: 0,
    rateLimitDownshifts: 0
  };

  const getFilteredDownload = () => selectSteadyStatePoints(state.downloadPoints, rampDiscardMs, 4);
  const getFilteredUpload = () => selectSteadyStatePoints(state.uploadPoints, rampDiscardMs, 4);

  const calcLat = (arr) => (arr.length > 0 ? computePercentile(arr, latencyPerc) : undefined);
  const calcBw = (pts) => {
    const bpsList = pts.map((p) => p.bps).filter((v) => isPositiveNumber(v));
    if (bpsList.length === 0) return undefined;
    return bpsList.reduce((acc, v) => acc + v, 0) / bpsList.length;
  };

  return {
    state,
    getDownloadBandwidthPoints: () => getFilteredDownload(),
    getUploadBandwidthPoints: () => getFilteredUpload(),
    getUnloadedLatencyPoints: () => state.unloadedLatencies.slice(),
    getDownLoadedLatencyPoints: () => state.downloadLoadedLatencies.slice(),
    getUpLoadedLatencyPoints: () => state.uploadLoadedLatencies.slice(),
    getDownloadBandwidth: () => calcBw(getFilteredDownload()),
    getUploadBandwidth: () => calcBw(getFilteredUpload()),
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
      latency: calcLat(state.unloadedLatencies),
      download: calcBw(getFilteredDownload()),
      upload: calcBw(getFilteredUpload()),
      downLoadedLatency: calcLat(state.downloadLoadedLatencies),
      upLoadedLatency: calcLat(state.uploadLoadedLatencies),
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

    const profile = TEST_PROFILES[profileId] || TEST_PROFILES.standard;
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

  async _probeLatencyOnce({ urlBase, during, pingTimeoutMs, signal, isLoaded }) {
    const url = buildProbeUrl(urlBase, { bytes: 0, during });
    const linked = createLinkedController(signal);
    const reqTimer = globalThis.setTimeout(() => linked.controller.abort('ping-timeout'), pingTimeoutMs);
    const start = performance.now();

    try {
      const res = await this._fetch(url, {
        cache: 'no-store',
        signal: linked.controller.signal
      });
      const wallMs = performance.now() - start;
      await res?.text?.().catch(() => {});
      if (!res?.ok || signal?.aborted) {
        return null;
      }

      const serverTimingHeader = res.headers?.get?.('server-timing') || '';
      const resourceTtfbMs = getResourceTtfbMs(url);
      return resolveNetworkRttMs({
        wallMs,
        resourceTtfbMs,
        serverTimingHeader,
        isLoaded
      });
    } catch {
      return null;
    } finally {
      clearTimeout(reqTimer);
      linked.cleanup();
    }
  }

  async _runLatencyPhase(runId, profile, accumulator, context, signal) {
    const opts = profile.options;
    const totalNeeded = opts.idlePingCount || 10;
    const maxBudgetMs = opts.maxIdleLatencyMs || 2000;
    const pingTimeoutMs = opts.pingTimeoutMs || 1200;
    const phaseStart = performance.now();
    const hardLimitMs = maxBudgetMs * 1.5;

    // 1 sonda de aquecimento TLS/rota (descartada)
    await this._probeLatencyOnce({
      urlBase: opts.downloadApiUrl,
      during: 'warmup',
      pingTimeoutMs,
      signal,
      isLoaded: false
    });

    for (let i = 0; i < totalNeeded + 2; i += 1) {
      if (!this._isActiveRun(runId, signal)) return;

      const elapsed = performance.now() - phaseStart;
      const gotEnough = accumulator.state.unloadedLatencies.length >= totalNeeded;
      const hitSoftDeadline =
        elapsed >= maxBudgetMs && accumulator.state.unloadedLatencies.length >= 5;
      if (gotEnough || hitSoftDeadline || elapsed >= hardLimitMs) {
        break;
      }

      const rttMs = await this._probeLatencyOnce({
        urlBase: opts.downloadApiUrl,
        during: 'idle',
        pingTimeoutMs,
        signal,
        isLoaded: false
      });

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
    onSample
  }) {
    while (!signal?.aborted && performance.now() < stopAt) {
      await delayWithSignal(throttleMs, signal);
      if (signal?.aborted || performance.now() >= stopAt) break;

      const rttMs = await this._probeLatencyOnce({
        urlBase,
        during,
        pingTimeoutMs,
        signal,
        isLoaded: true
      });
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
          const maxCap = opts.maxDownloadBytes || 5_000_000;
          if (sample.mbps > 350 && currentChunkBytes < maxCap) {
            currentChunkBytes = Math.min(maxCap, 10_000_000);
          } else if (sample.mbps > 60 && currentChunkBytes < Math.min(maxCap, 5_000_000)) {
            currentChunkBytes = Math.min(maxCap, 5_000_000);
          }
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
          urlBase: opts.downloadApiUrl,
          during: 'download',
          throttleMs: opts.loadedLatencyThrottle || 400,
          pingTimeoutMs: Math.max(opts.pingTimeoutMs || 1200, 1800),
          stopAt,
          signal: phaseSignal,
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
    onInFlightChange
  }) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
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
        if (lastLoaded > 0) {
          onInFlightChange(-lastLoaded);
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
        const loaded = Number(evt?.loaded) || 0;
        const delta = Math.max(0, loaded - lastLoaded);
        if (delta > 0) {
          lastLoaded = loaded;
          onInFlightChange(delta);
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
    let currentChunkBytes = opts.initialUploadBytes || 524_288;
    let confirmedBytes = 0;
    let inFlightBytes = 0;
    let recordedWatermark = 0;
    let lastActivityMarker = 0;

    this._emitProgressSnapshot(runId, 'upload', 56, accumulator, context, sessionSignal);

    const getEffectiveBytes = (relMs) => {
      const candidate =
        confirmedBytes > 0 ? confirmedBytes : relMs >= 1200 ? inFlightBytes : 0;
      recordedWatermark = Math.max(recordedWatermark, candidate);
      return recordedWatermark;
    };

    const adaptUploadChunkSize = (mbps, relMs) => {
      if (accumulator.state.rateLimitDownshifts > 0) return;
      const maxCap = opts.maxUploadBytes || 4_000_000;
      if (confirmedBytes === 0 && relMs >= 1200) {
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
      const effectiveBytes = getEffectiveBytes(relMs);
      ticks.push({ t: relMs, bytes: effectiveBytes });

      const activityNow = confirmedBytes + inFlightBytes;
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
        confirmedBytes === 0 &&
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
      if (workerId >= 2) {
        const staggerStart = performance.now();
        while (
          !phaseSignal.aborted &&
          confirmedBytes === 0 &&
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
                inFlightBytes = Math.max(0, inFlightBytes + delta);
                if (delta > 0) {
                  this.lastActivityAt = performance.now();
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
          confirmedBytes += chunkSize;
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
          urlBase: opts.downloadApiUrl,
          during: 'upload',
          throttleMs: opts.loadedLatencyThrottle || 400,
          pingTimeoutMs: Math.max(opts.pingTimeoutMs || 1200, 1800),
          stopAt,
          signal: phaseSignal,
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
    const finalEffectiveBytes = getEffectiveBytes(endRelMs);
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
        contractedMbps:
          isNonNegativeNumber(context.contractedMbps) && context.contractedMbps > 0
            ? context.contractedMbps
            : null,
        notes: typeof context.notes === 'string' ? context.notes.trim() : ''
      },
      metrics: {
        ...snapshot.metrics,
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
