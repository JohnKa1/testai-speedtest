/**
 * Validação rigorosa de dados e estados de métricas.
 * Garante que valores ausentes NUNCA sejam convertidos silenciosamente em zero.
 */

/** @type {Readonly<{ PENDING: 'pending', MEASURED: 'measured', UNAVAILABLE: 'unavailable', FAILED: 'failed' }>} */
export const METRIC_STATUS = Object.freeze({
  PENDING: 'pending',
  MEASURED: 'measured',
  UNAVAILABLE: 'unavailable',
  FAILED: 'failed'
});

export function isValidNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isNonNegativeNumber(value) {
  return isValidNumber(value) && value >= 0;
}

export function isPositiveNumber(value) {
  return isValidNumber(value) && value > 0;
}

export function clamp(value, min, max) {
  if (!isValidNumber(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * Cria um objeto estruturado para qualquer métrica do sistema.
 * @param {number | null} value
 * @param {import('../types.js').MetricStatus} [status]
 * @param {string} [unit]
 * @returns {import('../types.js').MetricEntry}
 */
export function createMetric(value, status = METRIC_STATUS.PENDING, unit = '') {
  if (status === METRIC_STATUS.MEASURED) {
    if (!isNonNegativeNumber(value)) {
      return {
        value: null,
        status: METRIC_STATUS.UNAVAILABLE,
        unit
      };
    }
    return {
      value,
      status: METRIC_STATUS.MEASURED,
      unit
    };
  }

  return {
    value: null,
    status,
    unit
  };
}

/**
 * Converte um valor numérico bruto da API em métrica validada.
 * Se hasError for true e o valor estiver ausente, marca como FAILED;
 * se não houve erro mas a API retornou undefined/null/NaN, marca como UNAVAILABLE.
 * @param {number | null | undefined} rawValue
 * @param {string} [unit]
 * @param {boolean} [hasError]
 * @returns {import('../types.js').MetricEntry}
 */
export function resolveMetric(rawValue, unit = '', hasError = false) {
  if (isNonNegativeNumber(rawValue)) {
    return createMetric(rawValue, METRIC_STATUS.MEASURED, unit);
  }
  return createMetric(
    null,
    hasError ? METRIC_STATUS.FAILED : METRIC_STATUS.UNAVAILABLE,
    unit
  );
}

/**
 * Filtra pontos de largura de banda válidos retornados pelo motor.
 */
export function sanitizeBandwidthPoints(points) {
  if (!Array.isArray(points)) {
    return [];
  }

  return points
    .filter((pt) => pt && isPositiveNumber(pt.bps))
    .map((pt, index) => ({
      index,
      bps: pt.bps,
      mbps: pt.bps / 1_000_000,
      bytes: isNonNegativeNumber(pt.bytes) ? pt.bytes : null,
      duration: isNonNegativeNumber(pt.duration) ? pt.duration : null,
      measTime: isNonNegativeNumber(pt.measTime) ? pt.measTime : null,
      ...(isNonNegativeNumber(pt.elapsedMs) ? { elapsedMs: pt.elapsedMs } : {})
    }));
}

/**
 * Filtra amostras de latência (RTT em ms) válidas.
 * A biblioteca pode retornar números simples ou objetos com propriedade ping/rtt/value.
 */
export function sanitizeLatencyPoints(points) {
  if (!Array.isArray(points)) {
    return [];
  }

  const normalized = [];

  points.forEach((item, index) => {
    let ms = null;
    if (isNonNegativeNumber(item)) {
      ms = item;
    } else if (item && typeof item === 'object') {
      if (isNonNegativeNumber(item.ping)) ms = item.ping;
      else if (isNonNegativeNumber(item.rtt)) ms = item.rtt;
      else if (isNonNegativeNumber(item.value)) ms = item.value;
    }

    if (isNonNegativeNumber(ms)) {
      normalized.push({ index, ms });
    }
  });

  return normalized;
}

/**
 * Verifica recursos mínimos do navegador para executar medições.
 */
export function checkBrowserCapabilities() {
  const missing = [];

  if (typeof window === 'undefined') {
    missing.push('Ambiente de janela (window) indisponível');
  }
  if (typeof fetch !== 'function') {
    missing.push('Fetch API');
  }
  if (typeof performance === 'undefined' || typeof performance.now !== 'function') {
    missing.push('High Resolution Time (performance.now)');
  }

  const online =
    typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
      ? navigator.onLine
      : true;

  return {
    supported: missing.length === 0,
    online,
    missing
  };
}