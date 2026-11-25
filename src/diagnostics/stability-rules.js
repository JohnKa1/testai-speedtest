/**
 * Fonte canônica compartilhada de limiares e regras de estabilidade do TestAi.
 * Garante coerência matemática entre os 4 classificadores:
 * - `capability-advisor.js` (`evaluateSimpleStability`)
 * - `connection-diagnostics.js` (`analyzeLoadedLatencySpikes`, `evaluateConnection`)
 * - `usage-verdict.js` (`evaluateUsageProfiles`)
 * - `gaming-analyzer.js` (`evaluateGamingReadiness`)
 */

import { isNonNegativeNumber, METRIC_STATUS } from '../utils/validators.js';

export const STABILITY_RULES = Object.freeze({
  // Variação de latência sob carga (Δ = loadedP50 - idleP50, em ms)
  loadedDeltaModerateMinMs: 30,
  loadedDeltaFpsAttentionMinMs: 50,
  loadedDeltaGamingWarnMinMs: 40,
  loadedDeltaSevereMinMs: 60,

  // Jitter ocioso (ms)
  idleJitterCompetitiveMaxMs: 5,
  idleJitterGoodMaxMs: 12,
  idleJitterFpsAttentionMinMs: 15,
  idleJitterSensitiveMinMs: 20,

  // Ping ocioso (ms)
  idlePingCompetitiveMaxMs: 25,
  idlePingGoodMaxMs: 45,
  idlePingElevatedMaxMs: 85,
  idlePingModerateStabilityMinMs: 150,
  idlePingCriticalStabilityMinMs: 300,

  // Spike Guard sob carga (acima do idlePing)
  mildSpikeDeltaMinMs: 80,
  severeSpikeDeltaMinMs: 250,
  recurrentSpikeMinCount: 3,
  recurrentSpikeMinRatio: 0.25,

  // Perda / Timeouts de sondas de latência
  moderateLossPctMin: 10,
  severeLossPctMin: 25,
  moderateLoadedTimeoutsMin: 2
});

/**
 * Analisa amostras individuais de latência sob carga (download e upload) aplicando
 * o Spike Guard: diferencia picos isolados leves (+80..249 ms) de picos isolados
 * severos (>= +250 ms acima do `idlePing`) e de picos recorrentes.
 *
 * @param {{
 *   metrics?: Partial<import('../types.js').SpeedTestMetrics>,
 *   series?: Partial<import('../types.js').SpeedTestResult['series']>
 * }} result
 * @param {{
 *   spikeDeltaThresholdMs?: number,
 *   severeDeltaThresholdMs?: number,
 *   recurrentCountMin?: number,
 *   recurrentRatioMin?: number
 * }} [options]
 * @returns {import('../types.js').LoadedLatencySpikes}
 */
export function evaluateLoadedLatencySpikes(result, options = {}) {
  const spikeDeltaThresholdMs =
    options.spikeDeltaThresholdMs ?? STABILITY_RULES.mildSpikeDeltaMinMs;
  const severeDeltaThresholdMs =
    options.severeDeltaThresholdMs ?? STABILITY_RULES.severeSpikeDeltaMinMs;
  const recurrentCountMin =
    options.recurrentCountMin ?? STABILITY_RULES.recurrentSpikeMinCount;
  const recurrentRatioMin =
    options.recurrentRatioMin ?? STABILITY_RULES.recurrentSpikeMinRatio;

  const idlePing =
    result?.metrics?.ping?.status === METRIC_STATUS.MEASURED &&
    isNonNegativeNumber(result.metrics.ping.value)
      ? result.metrics.ping.value
      : null;

  const dlRaw = Array.isArray(result?.series?.downloadLatencyPoints)
    ? result.series.downloadLatencyPoints
    : [];
  const ulRaw = Array.isArray(result?.series?.uploadLatencyPoints)
    ? result.series.uploadLatencyPoints
    : [];

  const extractSamples = (arr, phase) =>
    arr
      .map((pt) => (typeof pt === 'number' ? pt : pt?.ms))
      .filter((ms) => isNonNegativeNumber(ms))
      .map((ms) => ({ ms, phase }));

  const allSamples = [
    ...extractSamples(dlRaw, /** @type {'download'} */ ('download')),
    ...extractSamples(ulRaw, /** @type {'upload'} */ ('upload'))
  ];

  if (idlePing === null || allSamples.length === 0) {
    return {
      status: 'none',
      hasSevereSpike: false,
      thresholdDeltaMs: spikeDeltaThresholdMs,
      severeDeltaThresholdMs,
      totalSamples: allSamples.length,
      spikeCount: 0,
      spikeRatio: 0,
      peakMs: null,
      peakDeltaMs: null,
      peakPhase: null,
      downloadSpikeCount: 0,
      uploadSpikeCount: 0
    };
  }

  const spikeCutoffMs = idlePing + spikeDeltaThresholdMs;
  let downloadSpikeCount = 0;
  let uploadSpikeCount = 0;
  let peakMs = null;
  let peakDeltaMs = null;
  /** @type {'download' | 'upload' | null} */
  let peakPhase = null;

  for (const sample of allSamples) {
    if (sample.ms >= spikeCutoffMs) {
      if (sample.phase === 'download') downloadSpikeCount += 1;
      else uploadSpikeCount += 1;

      if (peakMs === null || sample.ms > peakMs) {
        peakMs = Math.round(sample.ms * 10) / 10;
        peakDeltaMs = Math.round(Math.max(0, sample.ms - idlePing) * 10) / 10;
        peakPhase = sample.phase;
      }
    }
  }

  const spikeCount = downloadSpikeCount + uploadSpikeCount;
  const totalSamples = allSamples.length;
  const spikeRatio = totalSamples > 0 ? spikeCount / totalSamples : 0;

  /** @type {'none' | 'isolated' | 'recurrent'} */
  let status = 'none';
  if (spikeCount >= recurrentCountMin || (spikeCount > 0 && spikeRatio >= recurrentRatioMin)) {
    status = 'recurrent';
  } else if (spikeCount >= 1) {
    status = 'isolated';
  }

  const hasSevereSpike = Boolean(
    status !== 'none' &&
      peakDeltaMs !== null &&
      peakDeltaMs >= severeDeltaThresholdMs
  );

  return {
    status,
    hasSevereSpike,
    thresholdDeltaMs: spikeDeltaThresholdMs,
    severeDeltaThresholdMs,
    totalSamples,
    spikeCount,
    spikeRatio,
    peakMs,
    peakDeltaMs,
    peakPhase,
    downloadSpikeCount,
    uploadSpikeCount
  };
}

/**
 * Consolida perda percentual e timeouts de sondas (`result.latencyProbes`) para
 * eliminar viés de sobrevivência quando pacotes sob carga estouram timeout.
 *
 * @param {any} result
 */
export function evaluateProbeLoss(result) {
  const probes = result?.latencyProbes;
  if (!probes || typeof probes !== 'object') {
    return {
      hasData: false,
      isSevereLoss: false,
      isModerateLoss: false,
      hasRelevantLoss: false,
      worstLossPct: 0,
      worstPhase: /** @type {'download' | 'upload' | 'repouso' | null} */ (null),
      loadedTimeouts: 0,
      totalFailures: 0,
      maxMs: null,
      p95Ms: null
    };
  }

  const idle = probes.idle || {};
  const dl = probes.download || {};
  const ul = probes.upload || {};

  const idleLoss = isNonNegativeNumber(idle.lossPct) ? idle.lossPct : 0;
  const dlLoss = isNonNegativeNumber(dl.lossPct) ? dl.lossPct : 0;
  const ulLoss = isNonNegativeNumber(ul.lossPct) ? ul.lossPct : 0;

  const dlTimeouts = isNonNegativeNumber(dl.timeouts) ? dl.timeouts : 0;
  const ulTimeouts = isNonNegativeNumber(ul.timeouts) ? ul.timeouts : 0;
  const idleTimeouts = isNonNegativeNumber(idle.timeouts) ? idle.timeouts : 0;
  const loadedTimeouts = dlTimeouts + ulTimeouts;

  const totalFailures =
    (isNonNegativeNumber(idle.failures) ? idle.failures : 0) +
    (isNonNegativeNumber(dl.failures) ? dl.failures : 0) +
    (isNonNegativeNumber(ul.failures) ? ul.failures : 0);

  let worstLossPct = 0;
  /** @type {'download' | 'upload' | 'repouso' | null} */
  let worstPhase = null;

  const candidates = [
    { phase: /** @type {'download'} */ ('download'), loss: dlLoss, timeouts: dlTimeouts },
    { phase: /** @type {'upload'} */ ('upload'), loss: ulLoss, timeouts: ulTimeouts },
    { phase: /** @type {'repouso'} */ ('repouso'), loss: idleLoss, timeouts: idleTimeouts }
  ];

  for (const item of candidates) {
    if (
      item.loss > worstLossPct ||
      (item.loss === worstLossPct && item.timeouts > 0 && worstPhase === null)
    ) {
      worstLossPct = item.loss;
      if (item.loss > 0 || item.timeouts > 0) {
        worstPhase = item.phase;
      }
    }
  }

  if (!worstPhase && loadedTimeouts > 0) {
    worstPhase = ulTimeouts >= dlTimeouts ? 'upload' : 'download';
  }

  const maxCandidates = [idle.maxMs, dl.maxMs, ul.maxMs].filter(isNonNegativeNumber);
  const p95Candidates = [idle.p95Ms, dl.p95Ms, ul.p95Ms].filter(isNonNegativeNumber);

  const isSevereLoss = worstLossPct >= STABILITY_RULES.severeLossPctMin;
  const isModerateLoss =
    !isSevereLoss &&
    (worstLossPct >= STABILITY_RULES.moderateLossPctMin ||
      loadedTimeouts >= STABILITY_RULES.moderateLoadedTimeoutsMin);

  return {
    hasData: true,
    isSevereLoss,
    isModerateLoss,
    hasRelevantLoss: isSevereLoss || isModerateLoss,
    worstLossPct: Math.round(worstLossPct * 100) / 100,
    worstPhase: worstPhase || 'download',
    loadedTimeouts,
    totalFailures,
    maxMs: maxCandidates.length > 0 ? Math.max(...maxCandidates) : null,
    p95Ms: p95Candidates.length > 0 ? Math.max(...p95Candidates) : null
  };
}
