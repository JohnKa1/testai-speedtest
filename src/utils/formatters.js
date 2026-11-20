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
 */
export function formatLatency(ms, decimals = 0, status = METRIC_STATUS.MEASURED) {
  if (status === METRIC_STATUS.PENDING) return '—';
  if (status === METRIC_STATUS.FAILED) return 'Falha';
  if (status === METRIC_STATUS.UNAVAILABLE || !isNonNegativeNumber(ms)) return 'N/D';
  return ms.toFixed(decimals);
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

  const percentile = (p) => {
    if (n === 1) return valid[0];
    const idx = p * (n - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return valid[lower];
    const weight = idx - lower;
    return valid[lower] * (1 - weight) + valid[upper] * weight;
  };

  const sum = valid.reduce((acc, v) => acc + v, 0);
  const mean = sum / n;
  const variance = valid.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? stdDev / mean : 0;

  return {
    count: n,
    min: valid[0],
    p10: percentile(0.1),
    p50: percentile(0.5),
    mean,
    p90: percentile(0.9),
    p95: percentile(0.95),
    max: valid[n - 1],
    stdDev,
    cv
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