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
 * @property {'gamepad' | 'video' | 'tv'} icon
 * @property {UsageVerdictLevel} level
 * @property {UsageVerdictLabel} label
 * @property {string} reason
 * @property {number} headroomPct
 * @property {string} headroomLabel
 */

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

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
      icon: /** @type {'gamepad'} */ ('gamepad'),
      level: /** @type {UsageVerdictLevel} */ ('atencao'),
      label: /** @type {UsageVerdictLabel} */ ('Atenção'),
      reason: 'Latência não pôde ser aferida completamente.',
      headroomPct: 12,
      headroomLabel: 'Sem medição de resposta'
    };
  }

  const effectiveJitter = isNonNegativeNumber(jitterMs) ? jitterMs : 0;
  const effectiveDelta = isNonNegativeNumber(loadedDeltaMs) ? loadedDeltaMs : 0;

  if (effectiveDelta >= 50 || pingMs > 60 || effectiveJitter > 15) {
    let reason = `Ping alto em repouso (${pingMs.toFixed(0)} ms).`;
    let headroomLabel = `Ping ${pingMs.toFixed(0)} ms (alvo competitivo < 45 ms)`;
    if (effectiveDelta >= 50) {
      reason = `Latência sobe +${effectiveDelta.toFixed(0)} ms sob carga (bufferbloat).`;
      headroomLabel = `Atraso extra sob carga reduz estabilidade`;
    } else if (effectiveJitter > 15) {
      reason = `Jitter elevado (${effectiveJitter.toFixed(1)} ms) causa instabilidade de mira.`;
      headroomLabel = `Oscilação alta no tempo de resposta`;
    }
    return {
      id: 'fps-gaming',
      title: 'Jogos FPS',
      icon: /** @type {'gamepad'} */ ('gamepad'),
      level: /** @type {UsageVerdictLevel} */ ('atencao'),
      label: /** @type {UsageVerdictLabel} */ ('Atenção'),
      reason,
      headroomPct: clampPercent(34 - Math.min(20, effectiveDelta / 10)),
      headroomLabel
    };
  }

  if (pingMs <= 25 && effectiveJitter <= 5 && effectiveDelta < 20) {
    const pingMargin = Math.max(0, Math.min(1, (60 - pingMs) / 50));
    const loadMargin = Math.max(0, Math.min(1, (50 - effectiveDelta) / 50));
    return {
      id: 'fps-gaming',
      title: 'Jogos FPS',
      icon: /** @type {'gamepad'} */ ('gamepad'),
      level: /** @type {UsageVerdictLevel} */ ('otimo'),
      label: /** @type {UsageVerdictLabel} */ ('Ótimo'),
      reason: `Ping ${pingMs.toFixed(0)} ms, jitter ${effectiveJitter.toFixed(1)} ms e Δ +${effectiveDelta.toFixed(0)} ms sob carga.`,
      headroomPct: clampPercent(72 + ((pingMargin + loadMargin) / 2) * 26),
      headroomLabel: `Folga de baixa latência · ${pingMs.toFixed(0)} ms (alvo < 25 ms)`
    };
  }

  return {
    id: 'fps-gaming',
    title: 'Jogos FPS',
    icon: /** @type {'gamepad'} */ ('gamepad'),
    level: /** @type {UsageVerdictLevel} */ ('bom'),
    label: /** @type {UsageVerdictLabel} */ ('Bom'),
    reason: `Jogável (${pingMs.toFixed(0)} ms), mas downloads pesados somam Δ +${effectiveDelta.toFixed(0)} ms.`,
    headroomPct: clampPercent(70 - effectiveDelta * 0.4),
    headroomLabel: `Jogável em ${pingMs.toFixed(0)} ms · leve variação com rede cheia`
  };
}

function evaluateVideoCalls(uploadMbps, loadedDeltaMs) {
  if (!isNonNegativeNumber(uploadMbps)) {
    return {
      id: 'video-calls',
      title: 'Videochamadas',
      icon: /** @type {'video'} */ ('video'),
      level: /** @type {UsageVerdictLevel} */ ('atencao'),
      label: /** @type {UsageVerdictLabel} */ ('Atenção'),
      reason: 'Taxa de envio (upload) indisponível ou falhou nesta rede.',
      headroomPct: 10,
      headroomLabel: 'Envio (upload) não medido'
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
      icon: /** @type {'video'} */ ('video'),
      level: /** @type {UsageVerdictLevel} */ ('atencao'),
      label: /** @type {UsageVerdictLabel} */ ('Atenção'),
      reason,
      headroomPct: uploadMbps < 10 ? clampPercent(Math.max(14, (uploadMbps / 10) * 32)) : 32,
      headroomLabel:
        uploadMbps < 10 ? 'Abaixo dos 10 Mbps recomendados' : 'Atraso alto durante envios'
    };
  }

  if (uploadMbps >= 25 && effectiveDelta < 25) {
    const streamsCount = Math.max(2, Math.min(12, Math.floor(uploadMbps / 10)));
    return {
      id: 'video-calls',
      title: 'Videochamadas',
      icon: /** @type {'video'} */ ('video'),
      level: /** @type {UsageVerdictLevel} */ ('otimo'),
      label: /** @type {UsageVerdictLabel} */ ('Ótimo'),
      reason: `Upload de ${uploadMbps.toFixed(1)} Mbps com resposta estável (Δ +${effectiveDelta.toFixed(0)} ms).`,
      headroomPct: clampPercent(70 + Math.min(28, (uploadMbps / 200) * 28)),
      headroomLabel: `Folga para ~${streamsCount} câmeras HD simultâneas`
    };
  }

  return {
    id: 'video-calls',
    title: 'Videochamadas',
    icon: /** @type {'video'} */ ('video'),
    level: /** @type {UsageVerdictLevel} */ ('bom'),
    label: /** @type {UsageVerdictLabel} */ ('Bom'),
    reason: `Upload de ${uploadMbps.toFixed(1)} Mbps atende chamadas Full HD com leve sensibilidade sob carga.`,
    headroomPct: clampPercent(48 + Math.min(24, (uploadMbps / 40) * 20)),
    headroomLabel: 'Atende 1–2 reuniões Full HD (requisito: 10 Mbps)'
  };
}

function evaluateStreaming4k(sustainedDownloadMbps, stability) {
  if (!isNonNegativeNumber(sustainedDownloadMbps)) {
    return {
      id: 'streaming-4k',
      title: 'Streaming 4K',
      icon: /** @type {'tv'} */ ('tv'),
      level: /** @type {UsageVerdictLevel} */ ('atencao'),
      label: /** @type {UsageVerdictLabel} */ ('Atenção'),
      reason: 'Download sustentado não foi medido.',
      headroomPct: 10,
      headroomLabel: 'Download sustentado não medido'
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
      icon: /** @type {'tv'} */ ('tv'),
      level: /** @type {UsageVerdictLevel} */ ('atencao'),
      label: /** @type {UsageVerdictLabel} */ ('Atenção'),
      reason,
      headroomPct:
        sustainedDownloadMbps < 25
          ? clampPercent(Math.max(14, (sustainedDownloadMbps / 25) * 34))
          : 34,
      headroomLabel:
        sustainedDownloadMbps < 25
          ? 'Abaixo de 25 Mbps por tela 4K'
          : 'Oscilação pode reduzir qualidade'
    };
  }

  if (sustainedDownloadMbps >= 50 && stabilityTone === 'good') {
    const screens4k = Math.max(2, Math.floor(sustainedDownloadMbps / 25));
    return {
      id: 'streaming-4k',
      title: 'Streaming 4K',
      icon: /** @type {'tv'} */ ('tv'),
      level: /** @type {UsageVerdictLevel} */ ('otimo'),
      label: /** @type {UsageVerdictLabel} */ ('Ótimo'),
      reason: `Vazão sustentada de ${sustainedDownloadMbps.toFixed(1)} Mbps com estabilidade ${stabilityLabel}.`,
      headroomPct: clampPercent(70 + Math.min(30, (sustainedDownloadMbps / 400) * 30)),
      headroomLabel: `Até ${screens4k} telas em 4K UHD ao mesmo tempo`
    };
  }

  const screens4k = Math.max(1, Math.floor(sustainedDownloadMbps / 25));
  return {
    id: 'streaming-4k',
    title: 'Streaming 4K',
    icon: /** @type {'tv'} */ ('tv'),
    level: /** @type {UsageVerdictLevel} */ ('bom'),
    label: /** @type {UsageVerdictLabel} */ ('Bom'),
    reason: `Suporta streaming 4K (${sustainedDownloadMbps.toFixed(1)} Mbps sustentados; estabilidade ${stabilityLabel}).`,
    headroomPct: clampPercent(46 + Math.min(26, (sustainedDownloadMbps / 100) * 25)),
    headroomLabel: `Folga para ${screens4k} tela(s) 4K (25 Mbps por tela)`
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
