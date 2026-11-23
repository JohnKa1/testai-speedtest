/**
 * Serviço de histórico comparativo (últimos 10 testes em localStorage)
 * e exportação segura em CSV/JSON sem dependências externas.
 */

import { DEFAULT_RUNTIME_CONFIG } from './runtime-config.js';
import { evaluateSimpleStability } from '../diagnostics/capability-advisor.js';
import { resolvePrimaryAndPeakSpeed } from '../utils/formatters.js';
import { isNonNegativeNumber, METRIC_STATUS } from '../utils/validators.js';

export const HISTORY_STORAGE_KEY = 'testai:history:v1';
export const MAX_HISTORY_ENTRIES = 10;

const CSV_HEADERS = [
  'id',
  'timestamp',
  'ispName',
  'serverLabel',
  'measurementMode',
  'downloadMbps',
  'uploadMbps',
  'pingMs',
  'jitterMs',
  'loadedDeltaMs',
  'stabilityLabel'
];

function getSafeStorage(storageOverride) {
  if (storageOverride !== undefined) {
    return storageOverride;
  }
  try {
    return typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

function roundNullable(value, decimals = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function readString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  return {
    id: readString(raw.id, `run-${Date.now()}`),
    timestamp: readString(raw.timestamp, new Date().toISOString()),
    ispName: readString(raw.ispName, DEFAULT_RUNTIME_CONFIG.ispName),
    serverLabel: readString(raw.serverLabel, DEFAULT_RUNTIME_CONFIG.serverLabel),
    measurementMode: raw.measurementMode === 'commercial' ? 'commercial' : 'sustained',
    downloadMbps: isNonNegativeNumber(raw.downloadMbps) ? roundNullable(raw.downloadMbps, 2) : null,
    uploadMbps: isNonNegativeNumber(raw.uploadMbps) ? roundNullable(raw.uploadMbps, 2) : null,
    pingMs: isNonNegativeNumber(raw.pingMs) ? roundNullable(raw.pingMs, 2) : null,
    jitterMs: isNonNegativeNumber(raw.jitterMs) ? roundNullable(raw.jitterMs, 2) : null,
    loadedDeltaMs: isNonNegativeNumber(raw.loadedDeltaMs) ? roundNullable(raw.loadedDeltaMs, 2) : null,
    stabilityLabel: readString(raw.stabilityLabel, 'Não avaliada')
  };
}

function persistEntries(entries, storageOverride) {
  const storage = getSafeStorage(storageOverride);
  if (!storage || typeof storage.setItem !== 'function') {
    return;
  }
  try {
    storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Falha de cota ou modo privado não interrompe o fluxo principal
  }
}

/**
 * Carrega até 10 entradas persistidas em `localStorage` com recuperação segura.
 *
 * @param {Storage | null} [storageOverride]
 * @returns {Array<ReturnType<typeof normalizeEntry> & {}>}
 */
export function loadHistoryEntries(storageOverride) {
  const storage = getSafeStorage(storageOverride);
  if (!storage || typeof storage.getItem !== 'function') {
    return [];
  }

  try {
    const raw = storage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeEntry)
      .filter((item) => item !== null)
      .slice(0, MAX_HISTORY_ENTRIES);
  } catch {
    return [];
  }
}

/**
 * Constrói um registro normalizado de histórico a partir do resultado do motor e da config atual.
 *
 * @param {any} result
 * @param {any} [runtimeConfig]
 */
export function buildHistoryEntry(result, runtimeConfig = DEFAULT_RUNTIME_CONFIG) {
  const cfg = runtimeConfig || DEFAULT_RUNTIME_CONFIG;
  const measurementMode =
    (result?.measurementMode || cfg.measurementMode) === 'commercial'
      ? 'commercial'
      : 'sustained';

  const m = result?.metrics || {};
  const dlInfo = resolvePrimaryAndPeakSpeed(
    result?.series?.downloadPoints || [],
    m.download,
    result?.stats?.download || null,
    { measurementMode }
  );
  const ulInfo = resolvePrimaryAndPeakSpeed(
    result?.series?.uploadPoints || [],
    m.upload,
    result?.stats?.upload || null,
    { measurementMode }
  );

  const dlDelta =
    m.downloadLatencyDelta?.status === METRIC_STATUS.MEASURED
      ? m.downloadLatencyDelta.value
      : null;
  const ulDelta =
    m.uploadLatencyDelta?.status === METRIC_STATUS.MEASURED
      ? m.uploadLatencyDelta.value
      : null;
  const validDeltas = [dlDelta, ulDelta].filter(isNonNegativeNumber);
  const maxDelta = validDeltas.length > 0 ? Math.max(...validDeltas) : null;

  const stability = evaluateSimpleStability(result, Boolean(result?.incomplete));

  return {
    id: readString(result?.id, `run-${Date.now()}`),
    timestamp: readString(result?.timestamp, new Date().toISOString()),
    ispName: readString(cfg.ispName, DEFAULT_RUNTIME_CONFIG.ispName),
    serverLabel: readString(cfg.serverLabel, DEFAULT_RUNTIME_CONFIG.serverLabel),
    measurementMode,
    downloadMbps:
      dlInfo.status === METRIC_STATUS.MEASURED && isNonNegativeNumber(dlInfo.primary)
        ? roundNullable(dlInfo.primary, 2)
        : null,
    uploadMbps:
      ulInfo.status === METRIC_STATUS.MEASURED && isNonNegativeNumber(ulInfo.primary)
        ? roundNullable(ulInfo.primary, 2)
        : null,
    pingMs:
      m.ping?.status === METRIC_STATUS.MEASURED && isNonNegativeNumber(m.ping.value)
        ? roundNullable(m.ping.value, 2)
        : null,
    jitterMs:
      m.jitter?.status === METRIC_STATUS.MEASURED && isNonNegativeNumber(m.jitter.value)
        ? roundNullable(m.jitter.value, 2)
        : null,
    loadedDeltaMs: isNonNegativeNumber(maxDelta) ? roundNullable(maxDelta, 2) : null,
    stabilityLabel: readString(stability?.label, 'Não avaliada')
  };
}

/**
 * Grava uma nova entrada no topo da lista respeitando o teto de 10 testes.
 *
 * @param {any} entry
 * @param {Storage | null} [storageOverride]
 */
export function saveHistoryEntry(entry, storageOverride) {
  const normalized = normalizeEntry(entry);
  const existing = loadHistoryEntries(storageOverride);
  if (!normalized) {
    return existing;
  }

  const deduped = existing.filter((item) => item.id !== normalized.id);
  const updated = [normalized, ...deduped].slice(0, MAX_HISTORY_ENTRIES);
  persistEntries(updated, storageOverride);
  return updated;
}

/**
 * Limpa todas as entradas do histórico comparativo em `localStorage`.
 *
 * @param {Storage | null} [storageOverride]
 * @returns {Array<never>}
 */
export function clearHistory(storageOverride) {
  const storage = getSafeStorage(storageOverride);
  if (storage && typeof storage.removeItem === 'function') {
    try {
      storage.removeItem(HISTORY_STORAGE_KEY);
    } catch {
      // Ignora erro de storage bloqueado
    }
  }
  return [];
}

/**
 * Calcula a diferença numérica entre o teste atual e o teste imediatamente anterior.
 * Retorna `null` caso não exista teste anterior.
 *
 * @param {any} current
 * @param {any} previous
 * @returns {{
 *   downloadDeltaMbps: number | null,
 *   uploadDeltaMbps: number | null,
 *   pingDeltaMs: number | null,
 *   loadedDeltaMs: number | null
 * } | null}
 */
export function computeComparisonDelta(current, previous) {
  if (!current || !previous) {
    return null;
  }

  const diffField = (currVal, prevVal) => {
    if (
      typeof currVal !== 'number' ||
      !Number.isFinite(currVal) ||
      typeof prevVal !== 'number' ||
      !Number.isFinite(prevVal)
    ) {
      return null;
    }
    return roundNullable(currVal - prevVal, 2);
  };

  return {
    downloadDeltaMbps: diffField(current.downloadMbps, previous.downloadMbps),
    uploadDeltaMbps: diffField(current.uploadMbps, previous.uploadMbps),
    pingDeltaMs: diffField(current.pingMs, previous.pingMs),
    loadedDeltaMs: diffField(current.loadedDeltaMs, previous.loadedDeltaMs)
  };
}

function escapeCsvCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Exporta as entradas do histórico em formato CSV com escape RFC 4180 seguro.
 *
 * @param {any[]} entries
 * @returns {string}
 */
export function exportHistoryAsCsv(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const headerLine = CSV_HEADERS.join(',');
  const rows = list.map((item) =>
    CSV_HEADERS.map((key) => escapeCsvCell(item?.[key])).join(',')
  );
  return [headerLine, ...rows].join('\n');
}

/**
 * Exporta as entradas do histórico em formato JSON formatado.
 *
 * @param {any[]} entries
 * @returns {string}
 */
export function exportHistoryAsJson(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return JSON.stringify(list, null, 2);
}
