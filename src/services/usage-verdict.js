/**
 * Avaliador objetivo de perfis de uso real (Jogos FPS, Videochamadas e Streaming 4K).
 * Traduz métricas de vazão, ping ocioso, jitter, Δ de latência sob carga e estabilidade
 * em 3 vereditos objetivos para o usuário final.
 */

import { evaluateSimpleStability } from '../diagnostics/capability-advisor.js';
import { isNonNegativeNumber, METRIC_STATUS } from '../utils/validators.js';

/**
 * @typedef {'otimo' | 'bom' | 'atencao'} UsageVerdictLevel
 * @typedef {'Ótimo' | 'Bom' | 'Atenção'} UsageVerdictLabel
 *
 * @typedef {Object} UsageVerdict
 * @property {string} id
 * @property {string} title
 * @property {UsageVerdictLevel} level
 * @property {UsageVerdictLabel} label
 * @property {string} reason
 */

function readMeasuredMetric(metric) {
  if (metric?.status !== METRIC_STATUS.MEASURED || !isNonNegativeNumber(metric?.value)) {
    return null;
  }
  return metric.value;
}

function resolveMaxLoadedDelta(metrics) {
  const dlDelta = readMeasuredMetric(metrics?.downloadLatencyDelta);
  const ulDelta = readMeasuredMetric(metrics?.uploadLatencyDelta);
  const values = [dlDelta, ulDelta].filter(isNonNegativeNumber);
  return values.length > 0 ? Math.max(...values) : null;
}

function resolveSustainedDownload(result) {
  const p50 = result?.stats?.download?.p50;
  if (isNonNegativeNumber(p50)) return p50;
  const mean = result?.stats?.download?.mean;
  if (isNonNegativeNumber(mean)) return mean;
  return readMeasuredMetric(result?.metrics?.download);
}

function evaluateFpsGaming(pingMs, jitterMs, loadedDeltaMs) {
  if (!isNonNegativeNumber(pingMs)) {
    return {
      id: 'fps-gaming',
      title: 'Jogos FPS',
      level: /** @type {UsageVerdictLevel} */ ('atencao'),
      label: /** @type {UsageVerdictLabel} */ ('Atenção'),
      reason: 'Latência não pôde ser aferida completamente.'
    };
  }

  const effectiveJitter = isNonNegativeNumber(jitterMs) ? jitterMs : 0;
  const effectiveDelta = isNonNegativeNumber(loadedDeltaMs) ? loadedDeltaMs : 0;

  if (effectiveDelta >= 50 || pingMs > 60 || effectiveJitter > 15) {
    let reason = `Ping alto em repouso (${pingMs.toFixed(0)} ms).`;
    if (effectiveDelta >= 50) {
      reason = `Latência sobe +${effectiveDelta.toFixed(0)} ms sob carga (bufferbloat).`;
    } else if (effectiveJitter > 15) {
      reason = `Jitter elevado (${effectiveJitter.toFixed(1)} ms) causa instabilidade de mira.`;
    }
    return {
      id: 'fps-gaming',
      title: 'Jogos FPS',
      level: /** @type {UsageVerdictLevel} */ ('atencao'),
      label: /** @type {UsageVerdictLabel} */ ('Atenção'),
      reason
    };
  }

  if (pingMs <= 25 && effectiveJitter <= 5 && effectiveDelta < 20) {
    return {
      id: 'fps-gaming',
      title: 'Jogos FPS',
      level: /** @type {UsageVerdictLevel} */ ('otimo'),
      label: /** @type {UsageVerdictLabel} */ ('Ótimo'),
      reason: `Ping ${pingMs.toFixed(0)} ms, jitter ${effectiveJitter.toFixed(1)} ms e Δ +${effectiveDelta.toFixed(0)} ms sob carga.`
    };
  }

  return {
    id: 'fps-gaming',
    title: 'Jogos FPS',
    level: /** @type {UsageVerdictLevel} */ ('bom'),
    label: /** @type {UsageVerdictLabel} */ ('Bom'),
    reason: `Jogável (${pingMs.toFixed(0)} ms), mas downloads pesados somam Δ +${effectiveDelta.toFixed(0)} ms.`
  };
}

function evaluateVideoCalls(uploadMbps, loadedDeltaMs) {
  if (!isNonNegativeNumber(uploadMbps)) {
    return {
      id: 'video-calls',
      title: 'Videochamadas',
      level: /** @type {UsageVerdictLevel} */ ('atencao'),
      label: /** @type {UsageVerdictLabel} */ ('Atenção'),
      reason: 'Taxa de envio (upload) indisponível ou falhou nesta rede.'
    };
  }

  const effectiveDelta = isNonNegativeNumber(loadedDeltaMs) ? loadedDeltaMs : 0;

  if (uploadMbps < 10 || effectiveDelta >= 60) {
    const reason =
      uploadMbps < 10
        ? `Upload reduzido (${uploadMbps.toFixed(1)} Mbps) pode travar imagem HD.`
        : `Atraso sob carga (+${effectiveDelta.toFixed(0)} ms) pode gerar picotes na voz.`;
    return {
      id: 'video-calls',
      title: 'Videochamadas',
      level: /** @type {UsageVerdictLevel} */ ('atencao'),
      label: /** @type {UsageVerdictLabel} */ ('Atenção'),
      reason
    };
  }

  if (uploadMbps >= 25 && effectiveDelta < 25) {
    return {
      id: 'video-calls',
      title: 'Videochamadas',
      level: /** @type {UsageVerdictLevel} */ ('otimo'),
      label: /** @type {UsageVerdictLabel} */ ('Ótimo'),
      reason: `Upload de ${uploadMbps.toFixed(1)} Mbps com resposta estável (Δ +${effectiveDelta.toFixed(0)} ms).`
    };
  }

  return {
    id: 'video-calls',
    title: 'Videochamadas',
    level: /** @type {UsageVerdictLevel} */ ('bom'),
    label: /** @type {UsageVerdictLabel} */ ('Bom'),
    reason: `Upload de ${uploadMbps.toFixed(1)} Mbps atende chamadas Full HD com leve sensibilidade sob carga.`
  };
}

function evaluateStreaming4k(sustainedDownloadMbps, stability) {
  if (!isNonNegativeNumber(sustainedDownloadMbps)) {
    return {
      id: 'streaming-4k',
      title: 'Streaming 4K',
      level: /** @type {UsageVerdictLevel} */ ('atencao'),
      label: /** @type {UsageVerdictLabel} */ ('Atenção'),
      reason: 'Download sustentado não foi medido.'
    };
  }

  const stabilityTone = stability?.tone || 'neutral';
  const stabilityLabel = stability?.label || 'Moderada';

  if (sustainedDownloadMbps < 25 || stabilityTone === 'danger') {
    const reason =
      sustainedDownloadMbps < 25
        ? `Download sustentado de ${sustainedDownloadMbps.toFixed(1)} Mbps é baixo para múltiplos streams 4K.`
        : `Estabilidade "${stabilityLabel}" pode causar quedas de qualidade no vídeo.`;
    return {
      id: 'streaming-4k',
      title: 'Streaming 4K',
      level: /** @type {UsageVerdictLevel} */ ('atencao'),
      label: /** @type {UsageVerdictLabel} */ ('Atenção'),
      reason
    };
  }

  if (sustainedDownloadMbps >= 50 && stabilityTone === 'good') {
    return {
      id: 'streaming-4k',
      title: 'Streaming 4K',
      level: /** @type {UsageVerdictLevel} */ ('otimo'),
      label: /** @type {UsageVerdictLabel} */ ('Ótimo'),
      reason: `Vazão sustentada de ${sustainedDownloadMbps.toFixed(1)} Mbps com estabilidade ${stabilityLabel}.`
    };
  }

  return {
    id: 'streaming-4k',
    title: 'Streaming 4K',
    level: /** @type {UsageVerdictLevel} */ ('bom'),
    label: /** @type {UsageVerdictLabel} */ ('Bom'),
    reason: `Suporta streaming 4K (${sustainedDownloadMbps.toFixed(1)} Mbps sustentados; estabilidade ${stabilityLabel}).`
  };
}

/**
 * Avalia 3 perfis objetivos de uso real para exibição imediata pós-teste.
 *
 * @param {any} result
 * @returns {UsageVerdict[]}
 */
export function evaluateUsageProfiles(result) {
  const m = result?.metrics || {};
  const pingMs = readMeasuredMetric(m.ping);
  const jitterMs = readMeasuredMetric(m.jitter);
  const loadedDeltaMs = resolveMaxLoadedDelta(m);
  const uploadMbps = readMeasuredMetric(m.upload);
  const sustainedDownloadMbps = resolveSustainedDownload(result);
  const stability = evaluateSimpleStability(result, Boolean(result?.incomplete));

  return [
    evaluateFpsGaming(pingMs, jitterMs, loadedDeltaMs),
    evaluateVideoCalls(uploadMbps, loadedDeltaMs),
    evaluateStreaming4k(sustainedDownloadMbps, stability)
  ];
}
