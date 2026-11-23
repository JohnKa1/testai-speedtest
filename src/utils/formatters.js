/**
 * Formatação de unidades, estatísticas reais e construção segura de DOM.
 */

import { isNonNegativeNumber, isValidNumber, METRIC_STATUS } from './validators.js';

/**
 * Converte bits por segundo (bps) em Megabits por segundo (Mbps decimal, padrão ITU/Telecom).
 * Retorna null se o dado for ausente ou inválido; preserva 0 se bps === 0.
 */
export function bpsToMbps(bps) {
  if (!isNonNegativeNumber(bps)) {
    return null;
  }
  return bps / 1_000_000;
}

/**
 * Calcula a diferença de latência sob carga (ΔRTT = loaded - idle).
 * Retorna null se qualquer uma das entradas for inválida/ausente.
 */
export function calculateLatencyDelta(idleMs, loadedMs) {
  if (!isNonNegativeNumber(idleMs) || !isNonNegativeNumber(loadedMs)) {
    return null;
  }
  return Math.max(0, loadedMs - idleMs);
}

/**
 * Formata velocidade em Mbps com fallback explícito conforme status.
 * @param {number | null | undefined} mbps
 * @param {number} [decimals]
 * @param {import('../types.js').MetricStatus} [status]
 * @returns {string}
 */
export function formatSpeed(mbps, decimals = 1, status = METRIC_STATUS.MEASURED) {
  if (status === METRIC_STATUS.PENDING) return '—';
  if (status === METRIC_STATUS.FAILED) return 'Falha';
  if (status === METRIC_STATUS.UNAVAILABLE || !isNonNegativeNumber(mbps)) return 'N/D';
  return mbps.toFixed(decimals);
}

/**
 * Formata velocidade adaptando para Gbps quando >= 1000 Mbps.
 */
export function formatAdaptiveSpeed(mbps) {
  if (!isNonNegativeNumber(mbps)) {
    return 'N/D';
  }
  if (mbps >= 1000) {
    return `${(mbps / 1000).toFixed(2)} Gbps`;
  }
  return `${mbps.toFixed(1)} Mbps`;
}

/**
 * Formata latência ou jitter em ms.
 * @param {number | null | undefined} ms
 * @param {number} [decimals]
 * @param {import('../types.js').MetricStatus} [status]
 * @returns {string}
 */
export function formatLatency(ms, decimals = 0, status = METRIC_STATUS.MEASURED) {
  if (status === METRIC_STATUS.PENDING) return '—';
  if (status === METRIC_STATUS.FAILED) return 'Falha';
  if (status === METRIC_STATUS.UNAVAILABLE || !isNonNegativeNumber(ms)) return 'N/D';
  return ms.toFixed(decimals);
}

/**
 * Formata métrica com unidade apenas quando há valor medido válido,
 * evitando saídas como "Falha Mbps" ou "N/D ms" em medições parciais.
 * @param {number | null | undefined} value
 * @param {string} unit
 * @param {number} [decimals]
 * @param {import('../types.js').MetricStatus} [status]
 * @returns {string}
 */
export function formatMetricWithUnit(
  value,
  unit,
  decimals = 1,
  status = METRIC_STATUS.MEASURED
) {
  if (status === METRIC_STATUS.PENDING) return '—';
  if (status === METRIC_STATUS.FAILED) return 'Falha';
  if (status === METRIC_STATUS.UNAVAILABLE || !isNonNegativeNumber(value)) return 'N/D';
  return `${value.toFixed(decimals)} ${unit}`;
}

/**
 * Converte velocidade em Mbps para percentual visual (0–100) em escala logarítmica suave.
 */
export function computeGaugePercent(mbps) {
  if (!isNonNegativeNumber(mbps) || mbps <= 0) {
    return 0;
  }
  const pct = (Math.log10(mbps + 1) / Math.log10(1201)) * 100;
  return Math.max(2, Math.min(100, Math.round(pct)));
}

/**
 * Formata variação de latência (+XX ms).
 */
export function formatDeltaMs(deltaMs) {
  if (!isNonNegativeNumber(deltaMs)) {
    return 'Δ N/D';
  }
  return `Δ +${deltaMs.toFixed(0)} ms`;
}

/**
 * Formata volume de dados transferidos (KB, MB, GB).
 */
export function formatBytes(bytes) {
  if (!isNonNegativeNumber(bytes)) {
    return 'N/D';
  }
  if (bytes === 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  const value = bytes / Math.pow(1000, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/**
 * Formata duração em segundos.
 */
export function formatDuration(ms) {
  if (!isNonNegativeNumber(ms)) {
    return 'N/D';
  }
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Formata data/hora ISO para pt-BR.
 */
export function formatDateTime(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function percentileFromSorted(sorted, percentile = 0.5) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];

  const clamped = Math.min(1, Math.max(0, Number(percentile) || 0));
  const idx = clamped * (n - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const weight = idx - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Calcula um percentil (0–1) a partir de um vetor numérico arbitrário.
 * Retorna null quando não há amostras numéricas válidas.
 */
export function computePercentile(values, percentile = 0.5) {
  if (!Array.isArray(values)) {
    return null;
  }
  const valid = values.filter(isValidNumber).sort((a, b) => a - b);
  return percentileFromSorted(valid, percentile);
}

/**
 * Calcula estatísticas descritivas reais a partir de um vetor numérico.
 * Nunca inventa amostras: retorna null quando o array está vazio.
 */
export function computeStats(values) {
  if (!Array.isArray(values)) {
    return null;
  }

  const valid = values.filter(isValidNumber).sort((a, b) => a - b);
  const n = valid.length;

  if (n === 0) {
    return null;
  }

  const sum = valid.reduce((acc, v) => acc + v, 0);
  const mean = sum / n;
  const variance = valid.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? stdDev / mean : 0;

  return {
    count: n,
    min: valid[0],
    p10: percentileFromSorted(valid, 0.1),
    p50: percentileFromSorted(valid, 0.5),
    mean,
    p90: percentileFromSorted(valid, 0.9),
    p95: percentileFromSorted(valid, 0.95),
    max: valid[n - 1],
    stdDev,
    cv
  };
}

/**
 * Calcula a média aritmética (Mbps) de uma série de amostras válidas.
 */
export function computeMeanMbps(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const valid = points.map((pt) => pt?.mbps).filter(isNonNegativeNumber);
  if (valid.length === 0) return null;
  return valid.reduce((acc, v) => acc + v, 0) / valid.length;
}

/**
 * Retorna o maior valor (Mbps) observado na série (pico pontual secundário).
 */
export function computePeakMbps(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const valid = points.map((pt) => pt?.mbps).filter(isNonNegativeNumber);
  if (valid.length === 0) return null;
  return Math.max(...valid);
}

/**
 * Retorna a mediana (P50 em Mbps) observada na série.
 */
export function computeP50Mbps(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const valid = points.map((pt) => pt?.mbps).filter(isNonNegativeNumber);
  return computePercentile(valid, 0.5);
}

/**
 * Retorna o percentil 90 (P90 em Mbps) observado na série.
 */
export function computeP90Mbps(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const valid = points.map((pt) => pt?.mbps).filter(isNonNegativeNumber);
  return computePercentile(valid, 0.9);
}

/**
 * Retorna os metadados canônicos de estatística e rótulo conforme o modo ativo.
 * Garante que o número principal e o rótulo exibidos no velocímetro, cards,
 * veredito e exportações utilizem exatamente o mesmo critério.
 *
 * @param {'commercial' | 'sustained' | string | undefined} [measurementMode]
 */
export function getCanonicalSpeedMeta(measurementMode = 'sustained') {
  if (measurementMode === 'commercial') {
    return {
      mode: /** @type {'commercial'} */ ('commercial'),
      statKey: /** @type {'p90'} */ ('p90'),
      shortLabel: 'P90',
      downloadTitle: 'DOWNLOAD (P90)',
      uploadTitle: 'Upload (P90)',
      simpleHeroLabel: 'DOWNLOAD (P90)',
      diagnosisLabel: 'P90 comercial'
    };
  }

  return {
    mode: /** @type {'sustained'} */ ('sustained'),
    statKey: /** @type {'p50'} */ ('p50'),
    shortLabel: 'P50',
    downloadTitle: 'DOWNLOAD (P50)',
    uploadTitle: 'Upload (P50)',
    simpleHeroLabel: 'DOWNLOAD (P50)',
    diagnosisLabel: 'P50 sustentado'
  };
}

/**
 * Resolve o valor principal (P50 sustentado ou P90 no modo comercial) e o pico secundário de velocidade.
 * Em falhas ou indisponibilidade preserva o status sem exibir unidade falsa.
 *
 * @param {any[]} points
 * @param {import('../types.js').MetricEntry} metric
 * @param {import('../types.js').DescriptiveStats | null} [statsObj]
 * @param {{ measurementMode?: 'sustained' | 'commercial' | string }} [options]
 * @returns {{ primary: number | null, peak: number | null, status: import('../types.js').MetricStatus, sustained?: number | null }}
 */
export function resolvePrimaryAndPeakSpeed(points, metric, statsObj = null, options = {}) {
  const peakFromSeries = computePeakMbps(points);
  const peak = isNonNegativeNumber(peakFromSeries)
    ? peakFromSeries
    : isNonNegativeNumber(statsObj?.max)
      ? statsObj.max
      : null;

  if (options?.measurementMode === 'commercial') {
    const p90FromSeries = computeP90Mbps(points);
    const p90 =
      metric?.status === METRIC_STATUS.MEASURED && isNonNegativeNumber(metric?.value)
        ? metric.value
        : isNonNegativeNumber(p90FromSeries)
          ? p90FromSeries
          : isNonNegativeNumber(statsObj?.p90)
            ? statsObj.p90
            : null;

    const p50FromSeries = computeP50Mbps(points);
    const sustained = isNonNegativeNumber(p50FromSeries)
      ? p50FromSeries
      : isNonNegativeNumber(statsObj?.p50)
        ? statsObj.p50
        : isNonNegativeNumber(statsObj?.mean)
          ? statsObj.mean
          : null;

    if (metric?.status === METRIC_STATUS.MEASURED) {
      return {
        primary: p90,
        sustained,
        peak,
        status: isNonNegativeNumber(p90) ? METRIC_STATUS.MEASURED : METRIC_STATUS.UNAVAILABLE
      };
    }

    return {
      primary: null,
      sustained,
      peak,
      status: metric?.status || METRIC_STATUS.UNAVAILABLE
    };
  }

  const p50FromSeries = computeP50Mbps(points);
  const sustainedP50 = isNonNegativeNumber(p50FromSeries)
    ? p50FromSeries
    : isNonNegativeNumber(statsObj?.p50)
      ? statsObj.p50
      : null;

  if (metric?.status === METRIC_STATUS.MEASURED) {
    const primary = isNonNegativeNumber(sustainedP50)
      ? sustainedP50
      : isNonNegativeNumber(metric.value)
        ? metric.value
        : null;
    return {
      primary,
      peak,
      status: isNonNegativeNumber(primary) ? METRIC_STATUS.MEASURED : METRIC_STATUS.UNAVAILABLE
    };
  }

  return {
    primary: null,
    peak,
    status: metric?.status || METRIC_STATUS.UNAVAILABLE
  };
}

/**
 * Helpers seguros de manipulação do DOM (prevenção de XSS).
 */
export function setText(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = value;
  }
}

export function clearElement(el) {
  if (!el) return;
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [className]
 * @param {string | number | null} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function createEl(tag, className = '', text = null) {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (text !== null && text !== undefined) {
    el.textContent = String(text);
  }
  return el;
}