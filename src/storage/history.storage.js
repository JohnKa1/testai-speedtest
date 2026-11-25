/**
 * Repositório canônico unificado de histórico local (`testai_history_v2`, schema v2),
 * migração transparente de registros legados (`testai:history:v1` e `v2` antigos),
 * comparação entre execuções e geração de relatórios técnicos (JSON, CSV e TXT).
 */

import {
  DEFAULT_RUNTIME_CONFIG,
  getRuntimeConfig,
  resolveRuntimeRoute
} from '../services/runtime-config.js';
import { evaluateSimpleStability } from '../diagnostics/capability-advisor.js';
import {
  evaluateLoadedLatencySpikes,
  evaluateProbeLoss
} from '../diagnostics/stability-rules.js';
import { isNonNegativeNumber, METRIC_STATUS } from '../utils/validators.js';
import {
  formatBytes,
  formatCoherentDeltaMs,
  formatDateTime,
  formatDeltaMs,
  formatDuration,
  formatLatency,
  formatSpeed,
  getCanonicalSpeedMeta,
  resolvePrimaryAndPeakSpeed
} from '../utils/formatters.js';

export const UNIFIED_HISTORY_KEY = 'testai_history_v2';
export const LEGACY_HISTORY_V1_KEY = 'testai:history:v1';
export const HISTORY_SCHEMA_VERSION = 2;
export const MAX_RECORDS = 100;

function resolveStorage(storage) {
  if (storage === null) return null;
  if (storage !== undefined) return storage;
  try {
    if (typeof window !== 'undefined' && window?.localStorage) {
      return window.localStorage;
    }
    return typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

function roundNullable(value, decimals = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
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

function normalizeSpikesSnapshot(rawSpikes) {
  if (!rawSpikes || typeof rawSpikes !== 'object' || Array.isArray(rawSpikes)) {
    return {
      status: 'none',
      hasSevereSpike: false,
      spikeCount: 0,
      totalSamples: 0,
      peakMs: null,
      peakDeltaMs: null,
      peakPhase: null
    };
  }
  const status =
    rawSpikes.status === 'recurrent' || rawSpikes.status === 'isolated'
      ? rawSpikes.status
      : 'none';
  const peakDeltaMs = roundNullable(rawSpikes.peakDeltaMs, 1);
  const hasSevereSpike =
    typeof rawSpikes.hasSevereSpike === 'boolean'
      ? rawSpikes.hasSevereSpike
      : Boolean(status !== 'none' && peakDeltaMs !== null && peakDeltaMs >= 250);

  return {
    status,
    hasSevereSpike,
    spikeCount: isNonNegativeNumber(rawSpikes.spikeCount) ? Math.floor(rawSpikes.spikeCount) : 0,
    totalSamples: isNonNegativeNumber(rawSpikes.totalSamples)
      ? Math.floor(rawSpikes.totalSamples)
      : 0,
    peakMs: roundNullable(rawSpikes.peakMs, 1),
    peakDeltaMs,
    peakPhase:
      rawSpikes.peakPhase === 'download' || rawSpikes.peakPhase === 'upload'
        ? rawSpikes.peakPhase
        : null
  };
}

function normalizeProbesSnapshot(rawProbes) {
  if (!rawProbes || typeof rawProbes !== 'object' || Array.isArray(rawProbes)) {
    return {
      maxMs: null,
      p95Ms: null,
      lossPct: 0,
      loadedTimeouts: 0,
      idle: null,
      download: null,
      upload: null
    };
  }

  const normPhase = (p) => {
    if (!p || typeof p !== 'object') return null;
    return {
      attempts: isNonNegativeNumber(p.attempts) ? Math.floor(p.attempts) : 0,
      succeeded: isNonNegativeNumber(p.succeeded) ? Math.floor(p.succeeded) : 0,
      timeouts: isNonNegativeNumber(p.timeouts) ? Math.floor(p.timeouts) : 0,
      failures: isNonNegativeNumber(p.failures) ? Math.floor(p.failures) : 0,
      lossPct: roundNullable(p.lossPct, 2) ?? 0,
      maxMs: roundNullable(p.maxMs, 2),
      p95Ms: roundNullable(p.p95Ms, 2)
    };
  };

  const idle = normPhase(rawProbes.idle);
  const download = normPhase(rawProbes.download);
  const upload = normPhase(rawProbes.upload);

  const phaseMaxList = [rawProbes.maxMs, idle?.maxMs, download?.maxMs, upload?.maxMs].filter(
    isNonNegativeNumber
  );
  const phaseP95List = [rawProbes.p95Ms, idle?.p95Ms, download?.p95Ms, upload?.p95Ms].filter(
    isNonNegativeNumber
  );
  const phaseLossList = [
    rawProbes.lossPct,
    idle?.lossPct,
    download?.lossPct,
    upload?.lossPct
  ].filter(isNonNegativeNumber);

  const loadedTimeouts = isNonNegativeNumber(rawProbes.loadedTimeouts)
    ? Math.floor(rawProbes.loadedTimeouts)
    : (download?.timeouts ?? 0) + (upload?.timeouts ?? 0);

  return {
    maxMs: phaseMaxList.length > 0 ? roundNullable(Math.max(...phaseMaxList), 2) : null,
    p95Ms: phaseP95List.length > 0 ? roundNullable(Math.max(...phaseP95List), 2) : null,
    lossPct: phaseLossList.length > 0 ? roundNullable(Math.max(...phaseLossList), 2) ?? 0 : 0,
    loadedTimeouts,
    idle,
    download,
    upload
  };
}

function inferRouteTypeFromRecord(raw) {
  if (raw?.routeType === 'on-net' || raw?.routeType === 'off-net-fallback') {
    return raw.routeType;
  }
  const serverLabel = readString(raw?.serverLabel, DEFAULT_RUNTIME_CONFIG.serverLabel);
  if (/cloudflare/i.test(serverLabel)) {
    return 'off-net-fallback';
  }
  return 'on-net';
}

/**
 * Normaliza qualquer registro (legado v1, legado v2 ou canônico schema v2) para o
 * formato unificado de persistência.
 *
 * @param {any} raw
 * @returns {import('../types.js').HistoryRecord | null}
 */
export function normalizeHistoryRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const id = readString(raw.id, '');
  if (!id) {
    return null;
  }

  const dlDelta = roundNullable(raw.downloadLatencyDeltaMs, 2);
  const ulDelta = roundNullable(raw.uploadLatencyDeltaMs, 2);
  const deltaCandidates = [raw.loadedDeltaMs, dlDelta, ulDelta].filter(isNonNegativeNumber);
  const loadedDeltaMs =
    deltaCandidates.length > 0 ? roundNullable(Math.max(...deltaCandidates), 2) : null;

  const rawStabilityObj =
    raw.stability && typeof raw.stability === 'object' ? raw.stability : null;
  const stabilityLabel = readString(
    rawStabilityObj?.label ?? raw.stabilityLabel,
    'Não avaliada'
  );
  const stabilityTone = readString(rawStabilityObj?.tone, 'neutral');
  const stabilityReason = readString(
    rawStabilityObj?.reason,
    loadedDeltaMs !== null ? `Variação +${Math.round(loadedDeltaMs)} ms` : 'Registro histórico'
  );

  const serverLabel = readString(raw.serverLabel, DEFAULT_RUNTIME_CONFIG.serverLabel);
  const routeType = inferRouteTypeFromRecord({ ...raw, serverLabel });
  const measurementMode = raw.measurementMode === 'commercial' ? 'commercial' : 'sustained';
  const downloadMbps = roundNullable(raw.downloadMbps, 2);
  const uploadMbps = roundNullable(raw.uploadMbps, 2);

  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    id,
    timestamp: readString(raw.timestamp, new Date().toISOString()),
    incomplete: Boolean(raw.incomplete),
    durationMs: isNonNegativeNumber(raw.durationMs) ? Math.round(raw.durationMs) : 0,
    ispName: readString(raw.ispName, DEFAULT_RUNTIME_CONFIG.ispName),
    serverLabel,
    routeType,
    measurementMode,
    profileLabel: readString(raw.profileLabel, 'Padrão'),
    context:
      raw.context && typeof raw.context === 'object' && !Array.isArray(raw.context)
        ? raw.context
        : {},
    downloadMbps,
    sustainedDownloadMbps: roundNullable(
      raw.sustainedDownloadMbps ?? (measurementMode === 'sustained' ? downloadMbps : null),
      2
    ),
    uploadMbps,
    sustainedUploadMbps: roundNullable(
      raw.sustainedUploadMbps ?? (measurementMode === 'sustained' ? uploadMbps : null),
      2
    ),
    pingMs: roundNullable(raw.pingMs, 2),
    jitterMs: roundNullable(raw.jitterMs, 2),
    downloadLatencyMs: roundNullable(raw.downloadLatencyMs, 2),
    uploadLatencyMs: roundNullable(raw.uploadLatencyMs, 2),
    downloadLatencyDeltaMs: dlDelta,
    uploadLatencyDeltaMs: ulDelta,
    loadedDeltaMs,
    downloadJitterMs: roundNullable(raw.downloadJitterMs, 2),
    uploadJitterMs: roundNullable(raw.uploadJitterMs, 2),
    totalBytes: isNonNegativeNumber(raw.totalBytes) ? Math.round(raw.totalBytes) : null,
    loadedSpikes: normalizeSpikesSnapshot(raw.loadedSpikes),
    latencyProbes: normalizeProbesSnapshot(raw.latencyProbes),
    stability: {
      label: stabilityLabel,
      tone: stabilityTone,
      reason: stabilityReason
    },
    stabilityLabel,
    diagnosisCode: readString(raw.diagnosisCode, 'inconclusive'),
    diagnosisTitle: readString(raw.diagnosisTitle, stabilityLabel),
    diagnosisSummary: readString(raw.diagnosisSummary, ''),
    gamingBadge: readString(raw.gamingBadge, 'N/D')
  };
}

function mergeDuplicateRecord(primaryRec, secondaryRec) {
  return normalizeHistoryRecord({
    ...secondaryRec,
    ...primaryRec,
    ispName:
      primaryRec.ispName && primaryRec.ispName !== DEFAULT_RUNTIME_CONFIG.ispName
        ? primaryRec.ispName
        : secondaryRec.ispName || primaryRec.ispName,
    serverLabel:
      primaryRec.serverLabel && primaryRec.serverLabel !== DEFAULT_RUNTIME_CONFIG.serverLabel
        ? primaryRec.serverLabel
        : secondaryRec.serverLabel || primaryRec.serverLabel,
    measurementMode:
      primaryRec.measurementMode === 'commercial' || secondaryRec.measurementMode === 'commercial'
        ? 'commercial'
        : 'sustained',
    downloadLatencyMs: primaryRec.downloadLatencyMs ?? secondaryRec.downloadLatencyMs,
    uploadLatencyMs: primaryRec.uploadLatencyMs ?? secondaryRec.uploadLatencyMs,
    downloadLatencyDeltaMs:
      primaryRec.downloadLatencyDeltaMs ?? secondaryRec.downloadLatencyDeltaMs,
    uploadLatencyDeltaMs: primaryRec.uploadLatencyDeltaMs ?? secondaryRec.uploadLatencyDeltaMs,
    loadedDeltaMs: primaryRec.loadedDeltaMs ?? secondaryRec.loadedDeltaMs,
    stability:
      primaryRec.stability?.label && primaryRec.stability.label !== 'Não avaliada'
        ? primaryRec.stability
        : secondaryRec.stability || primaryRec.stability,
    diagnosisTitle:
      primaryRec.diagnosisTitle && primaryRec.diagnosisTitle !== 'Não avaliada'
        ? primaryRec.diagnosisTitle
        : secondaryRec.diagnosisTitle || primaryRec.diagnosisTitle
  });
}

function parseStoredArray(storage, key) {
  if (!storage || typeof storage.getItem !== 'function') {
    return { hadKey: false, corrupted: false, items: [] };
  }
  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return { hadKey: false, corrupted: false, items: [] };
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { hadKey: true, corrupted: true, items: [] };
    }
    return { hadKey: true, corrupted: false, items: parsed };
  } catch {
    return { hadKey: true, corrupted: true, items: [] };
  }
}

export function loadHistory(storage) {
  const store = resolveStorage(storage);
  if (!store) return [];

  const v2Parsed = parseStoredArray(store, UNIFIED_HISTORY_KEY);
  const v1Parsed = parseStoredArray(store, LEGACY_HISTORY_V1_KEY);

  if (v2Parsed.items.length === 0 && v1Parsed.items.length === 0) {
    return [];
  }

  /** @type {Map<string, import('../types.js').HistoryRecord>} */
  const byId = new Map();
  let needsRewrite = v1Parsed.hadKey;

  for (const item of v2Parsed.items) {
    if (item?.schemaVersion !== HISTORY_SCHEMA_VERSION) {
      needsRewrite = true;
    }
    const norm = normalizeHistoryRecord(item);
    if (norm && !byId.has(norm.id)) {
      byId.set(norm.id, norm);
    }
  }

  for (const legacyItem of v1Parsed.items) {
    const normLegacy = normalizeHistoryRecord(legacyItem);
    if (!normLegacy) continue;
    if (byId.has(normLegacy.id)) {
      const merged = mergeDuplicateRecord(byId.get(normLegacy.id), normLegacy);
      if (merged) byId.set(normLegacy.id, merged);
    } else {
      byId.set(normLegacy.id, normLegacy);
    }
  }

  const unified = [...byId.values()];
  if (v1Parsed.items.length > 0 && v2Parsed.items.length > 0) {
    unified.sort((a, b) => {
      const ta = Date.parse(a.timestamp);
      const tb = Date.parse(b.timestamp);
      if (Number.isFinite(ta) && Number.isFinite(tb)) {
        return tb - ta;
      }
      return 0;
    });
  }

  const trimmed = unified.slice(0, MAX_RECORDS);

  if (needsRewrite) {
    saveHistory(trimmed, store);
    if (typeof store.removeItem === 'function') {
      try {
        store.removeItem(LEGACY_HISTORY_V1_KEY);
      } catch {
        // noop
      }
    }
  }

  return trimmed;
}

export function saveHistory(records, storage) {
  const store = resolveStorage(storage);
  if (!store || typeof store.setItem !== 'function') return false;
  try {
    const normalized = Array.isArray(records)
      ? records
          .map((item) => normalizeHistoryRecord(item))
          .filter((item) => item !== null)
          .slice(0, MAX_RECORDS)
      : [];
    store.setItem(UNIFIED_HISTORY_KEY, JSON.stringify(normalized));
    if (typeof store.removeItem === 'function') {
      store.removeItem(LEGACY_HISTORY_V1_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import('../types.js').SpeedTestResult & { ispName?: string, serverLabel?: string }} result
 * @param {import('../types.js').DiagnosisResult | null} [diagnosis]
 * @param {import('../types.js').GamingResult | null} [gaming]
 * @param {any} [runtimeConfig]
 * @returns {import('../types.js').HistoryRecord}
 */
export function toHistoryRecord(result, diagnosis = null, gaming = null, runtimeConfig = null) {
  const cfg = runtimeConfig || getRuntimeConfig() || DEFAULT_RUNTIME_CONFIG;
  const m = /** @type {Partial<import('../types.js').SpeedTestMetrics>} */ (
    result?.metrics || {}
  );
  const measurementMode =
    (result?.measurementMode || cfg?.measurementMode) === 'commercial'
      ? 'commercial'
      : 'sustained';
  const routeType =
    result?.routeType === 'on-net' || result?.routeType === 'off-net-fallback'
      ? result.routeType
      : resolveRuntimeRoute(cfg);

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

  const dlPrimary =
    m.download?.status === METRIC_STATUS.MEASURED && isNonNegativeNumber(m.download?.value)
      ? m.download.value
      : dlInfo.primary;
  const ulPrimary =
    m.upload?.status === METRIC_STATUS.MEASURED && isNonNegativeNumber(m.upload?.value)
      ? m.upload.value
      : ulInfo.primary;

  const sustainedDl = isNonNegativeNumber(result?.stats?.download?.p50)
    ? result.stats.download.p50
    : dlInfo.sustained ?? (measurementMode === 'sustained' ? dlPrimary : null);
  const sustainedUl = isNonNegativeNumber(result?.stats?.upload?.p50)
    ? result.stats.upload.p50
    : ulInfo.sustained ?? (measurementMode === 'sustained' ? ulPrimary : null);

  const dlDelta =
    m.downloadLatencyDelta?.status === METRIC_STATUS.MEASURED
      ? m.downloadLatencyDelta.value
      : isNonNegativeNumber(m.downloadLatencyDelta?.value)
        ? m.downloadLatencyDelta.value
        : null;
  const ulDelta =
    m.uploadLatencyDelta?.status === METRIC_STATUS.MEASURED
      ? m.uploadLatencyDelta.value
      : isNonNegativeNumber(m.uploadLatencyDelta?.value)
        ? m.uploadLatencyDelta.value
        : null;
  const validDeltas = [dlDelta, ulDelta].filter(isNonNegativeNumber);
  const loadedDeltaMs = validDeltas.length > 0 ? Math.max(...validDeltas) : null;

  const stability = evaluateSimpleStability(result, Boolean(result?.incomplete));
  const rawSpikes = result?.loadedSpikes;
  const evaluatedSpikes =
    rawSpikes && typeof rawSpikes.hasSevereSpike === 'boolean'
      ? rawSpikes
      : evaluateLoadedLatencySpikes(result);
  const probeLoss = evaluateProbeLoss(result);

  const latencyProbes = normalizeProbesSnapshot(
    result?.latencyProbes
      ? {
          ...result.latencyProbes,
          maxMs: probeLoss.maxMs,
          p95Ms: probeLoss.p95Ms,
          lossPct: probeLoss.worstLossPct,
          loadedTimeouts: probeLoss.loadedTimeouts
        }
      : null
  );

  return normalizeHistoryRecord({
    schemaVersion: HISTORY_SCHEMA_VERSION,
    id: readString(result?.id, `run-${Date.now()}`),
    timestamp: readString(result?.timestamp, new Date().toISOString()),
    incomplete: Boolean(result?.incomplete),
    durationMs: result?.durationMs ?? 0,
    ispName: readString(result?.ispName ?? cfg?.ispName, DEFAULT_RUNTIME_CONFIG.ispName),
    serverLabel: readString(
      result?.serverLabel ?? cfg?.serverLabel,
      DEFAULT_RUNTIME_CONFIG.serverLabel
    ),
    routeType,
    measurementMode,
    profileLabel: result?.profile?.label || 'Padrão',
    context: result?.context || {},
    downloadMbps: dlPrimary,
    sustainedDownloadMbps: sustainedDl,
    uploadMbps: ulPrimary,
    sustainedUploadMbps: sustainedUl,
    pingMs: m.ping?.value ?? null,
    jitterMs: m.jitter?.value ?? null,
    downloadLatencyMs: m.downloadLatency?.value ?? null,
    uploadLatencyMs: m.uploadLatency?.value ?? null,
    downloadLatencyDeltaMs: dlDelta,
    uploadLatencyDeltaMs: ulDelta,
    loadedDeltaMs,
    downloadJitterMs: m.downloadJitter?.value ?? null,
    uploadJitterMs: m.uploadJitter?.value ?? null,
    totalBytes:
      result?.transfer?.totalBytes ??
      (isNonNegativeNumber(result?.transfer?.totalDownloadBytes) ||
      isNonNegativeNumber(result?.transfer?.totalUploadBytes)
        ? (result?.transfer?.totalDownloadBytes || 0) +
          (result?.transfer?.totalUploadBytes || 0)
        : null),
    loadedSpikes: evaluatedSpikes,
    latencyProbes,
    stability: {
      label: stability.label,
      tone: stability.tone,
      reason: stability.sub
    },
    stabilityLabel: stability.label,
    diagnosisCode: diagnosis?.code || 'inconclusive',
    diagnosisTitle: diagnosis?.title || stability.label,
    diagnosisSummary: diagnosis?.summary || '',
    gamingBadge: gaming?.badge || 'N/D'
  });
}

export function appendHistoryRecord(record, storage) {
  const store = resolveStorage(storage);
  const current = loadHistory(store);
  const normalized = normalizeHistoryRecord(record);
  if (!normalized) return current;
  const updated = [normalized, ...current.filter((r) => r.id !== normalized.id)].slice(
    0,
    MAX_RECORDS
  );
  saveHistory(updated, store);
  return updated;
}

export function deleteHistoryRecord(id, storage) {
  const store = resolveStorage(storage);
  const current = loadHistory(store);
  const updated = current.filter((r) => r.id !== id);
  saveHistory(updated, store);
  return updated;
}

export function clearHistory(storage) {
  const store = resolveStorage(storage);
  if (store) {
    try {
      store.removeItem?.(UNIFIED_HISTORY_KEY);
      store.removeItem?.(LEGACY_HISTORY_V1_KEY);
    } catch {
      // noop
    }
  }
  return [];
}

/**
 * Compara duas execuções salvas (mais recente vs. anterior).
 */
export function compareHistoryRecords(newer, older) {
  if (!newer || !older) return null;

  const diff = (a, b) =>
    isNonNegativeNumber(a) && isNonNegativeNumber(b)
      ? Math.round((a - b) * 100) / 100
      : null;

  return {
    newer,
    older,
    downloadDiffMbps: diff(newer.downloadMbps, older.downloadMbps),
    uploadDiffMbps: diff(newer.uploadMbps, older.uploadMbps),
    pingDiffMs: diff(newer.pingMs, older.pingMs),
    jitterDiffMs: diff(newer.jitterMs, older.jitterMs)
  };
}

export function exportHistoryJson(records) {
  const list = Array.isArray(records) ? records : [];
  return JSON.stringify(
    {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      application: 'TestAi Network Diagnostics',
      exportedAt: new Date().toISOString(),
      count: list.length,
      records: list
    },
    null,
    2
  );
}

export const UNIFIED_CSV_HEADERS = Object.freeze([
  'schemaVersion',
  'id',
  'timestamp',
  'ispName',
  'serverLabel',
  'routeType',
  'measurementMode',
  'profile',
  'linkType',
  'downloadMbps',
  'sustainedDownloadMbps',
  'uploadMbps',
  'sustainedUploadMbps',
  'pingMs',
  'jitterMs',
  'downloadLatencyMs',
  'uploadLatencyMs',
  'downloadLatencyDeltaMs',
  'uploadLatencyDeltaMs',
  'loadedDeltaMs',
  'spikeStatus',
  'spikePeakMs',
  'probeLossPct',
  'probeP95Ms',
  'probeMaxMs',
  'stabilityLabel',
  'stabilityTone',
  'stabilityReason',
  'diagnosis'
]);

function escapeCsvCell(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportHistoryCsv(records) {
  const list = Array.isArray(records) ? records : [];
  const rows = list.map((raw) => {
    const r = normalizeHistoryRecord(raw) || raw || {};
    return [
      r.schemaVersion ?? HISTORY_SCHEMA_VERSION,
      r.id ?? '',
      r.timestamp ?? '',
      r.ispName ?? '',
      r.serverLabel ?? '',
      r.routeType ?? '',
      r.measurementMode ?? '',
      r.profileLabel ?? '',
      r.context?.linkType || '',
      r.downloadMbps ?? '',
      r.sustainedDownloadMbps ?? '',
      r.uploadMbps ?? '',
      r.sustainedUploadMbps ?? '',
      r.pingMs ?? '',
      r.jitterMs ?? '',
      r.downloadLatencyMs ?? '',
      r.uploadLatencyMs ?? '',
      r.downloadLatencyDeltaMs ?? '',
      r.uploadLatencyDeltaMs ?? '',
      r.loadedDeltaMs ?? '',
      r.loadedSpikes?.status ?? 'none',
      r.loadedSpikes?.peakMs ?? '',
      r.latencyProbes?.lossPct ?? 0,
      r.latencyProbes?.p95Ms ?? '',
      r.latencyProbes?.maxMs ?? '',
      r.stability?.label ?? r.stabilityLabel ?? '',
      r.stability?.tone ?? '',
      r.stability?.reason ?? '',
      r.diagnosisTitle ?? ''
    ]
      .map(escapeCsvCell)
      .join(',');
  });

  return [UNIFIED_CSV_HEADERS.join(','), ...rows].join('\n');
}

/**
 * Gera laudo técnico completo em texto puro para suporte, NOC ou provedor,
 * refletindo dinamicamente o servidor e a rota medida (On-Net vs Off-Net).
 *
 * @param {import('../types.js').SpeedTestResult} result
 * @param {import('../types.js').DiagnosisResult} diagnosis
 * @param {import('../types.js').GamingResult} gaming
 * @param {string} [notes]
 * @param {any} [runtimeConfig]
 * @returns {string}
 */
export function buildTechnicalReportTxt(
  result,
  diagnosis,
  gaming,
  notes = '',
  runtimeConfig = null
) {
  const cfg = runtimeConfig || getRuntimeConfig() || DEFAULT_RUNTIME_CONFIG;
  const m = result.metrics;
  const routeType =
    result?.routeType === 'on-net' || result?.routeType === 'off-net-fallback'
      ? result.routeType
      : resolveRuntimeRoute(cfg);
  const ispName = readString(cfg?.ispName, DEFAULT_RUNTIME_CONFIG.ispName);
  const serverLabel = readString(
    cfg?.serverLabel,
    routeType === 'on-net' ? 'On-Net Server' : DEFAULT_RUNTIME_CONFIG.serverLabel
  );
  const targetDescription =
    routeType === 'on-net'
      ? `${serverLabel} (${ispName} · Servidor Local On-Net)`
      : `${serverLabel} (Rota Externa Off-Net · Cloudflare Edge)`;

  const speedMeta = getCanonicalSpeedMeta(result.measurementMode);
  const dlLabel = `Download (${speedMeta.shortLabel})`.padEnd(22, ' ');
  const ulLabel = `Upload (${speedMeta.shortLabel})`.padEnd(22, ' ');
  const dlP50Note = isNonNegativeNumber(result.stats?.download?.p50)
    ? ` · P50: ${result.stats.download.p50.toFixed(1)} Mbps`
    : '';
  const ulP50Note = isNonNegativeNumber(result.stats?.upload?.p50)
    ? ` · P50: ${result.stats.upload.p50.toFixed(1)} Mbps`
    : '';

  const dlDeltaDisplay = formatCoherentDeltaMs(
    m.ping?.value,
    m.downloadLatency?.value,
    m.downloadLatencyDelta?.value
  );
  const ulDeltaDisplay = formatCoherentDeltaMs(
    m.ping?.value,
    m.uploadLatency?.value,
    m.uploadLatencyDelta?.value
  );

  const spikesNote =
    result.loadedSpikes &&
    result.loadedSpikes.status !== 'none' &&
    result.loadedSpikes.peakMs !== null
      ? [
          `Picos sob Carga       : ${result.loadedSpikes.spikeCount}/${result.loadedSpikes.totalSamples} amostras (máx ${Math.round(result.loadedSpikes.peakMs)} ms no ${result.loadedSpikes.peakPhase})`
        ]
      : [];

  const probeLoss = evaluateProbeLoss(result);
  const probeLossNote =
    probeLoss.hasData && (probeLoss.worstLossPct > 0 || probeLoss.loadedTimeouts > 0)
      ? [
          `Perda de Sondas       : ${probeLoss.worstLossPct.toFixed(1)}% (fase ${probeLoss.worstPhase} · ${probeLoss.loadedTimeouts} timeout(s) sob carga)`
        ]
      : [];

  const gamingRouteNote =
    routeType === 'on-net'
      ? `Medição realizada até o servidor local On-Net (${serverLabel}); o ping em partidas online também varia conforme a região física do servidor do jogo.`
      : `Medição realizada até a borda externa (${serverLabel}); não representa ping direto à rede interna do provedor nem a servidores específicos de jogos.`;

  const lines = [
    '====================================================================',
    'TESTAI — LAUDO TÉCNICO DE DIAGNÓSTICO DE REDE',
    '====================================================================',
    `Sessão ID       : ${result.id}`,
    `Data / Hora     : ${formatDateTime(result.timestamp)}`,
    `Destino de Teste: ${targetDescription}`,
    `Perfil          : ${result.profile?.label || 'Padrão'}`,
    `Duração         : ${formatDuration(result.durationMs)}`,
    `Volume Transfer.: ${formatBytes(result.transfer?.totalBytes)}`,
    `Meio Declarado  : ${result.context?.linkType || 'não informado'}`,
    `Plano Declarado : ${result.context?.contractedMbps ? `${result.context.contractedMbps} Mbps` : 'não informado'}`,
    ...(notes ? [`Observações     : ${notes}`] : []),
    '',
    '--------------------------------------------------------------------',
    '1. MÉTRICAS CONSOLIDADAS',
    '--------------------------------------------------------------------',
    `${dlLabel}: ${formatSpeed(m.download?.value, 1, m.download?.status)} Mbps${dlP50Note}`,
    `${ulLabel}: ${formatSpeed(m.upload?.value, 1, m.upload?.status)} Mbps${ulP50Note}`,
    `Latência Ociosa (P50) : ${formatLatency(m.ping?.value, 0, m.ping?.status)} ms`,
    `Jitter Ocioso         : ${formatLatency(m.jitter?.value, 1, m.jitter?.status)} ms`,
    `Latência sob Download : ${formatLatency(m.downloadLatency?.value, 0, m.downloadLatency?.status)} ms (${dlDeltaDisplay})`,
    `Latência sob Upload   : ${formatLatency(m.uploadLatency?.value, 0, m.uploadLatency?.status)} ms (${ulDeltaDisplay})`,
    `Jitter sob Download   : ${formatLatency(m.downloadJitter?.value, 1, m.downloadJitter?.status)} ms`,
    `Jitter sob Upload     : ${formatLatency(m.uploadJitter?.value, 1, m.uploadJitter?.status)} ms`,
    ...spikesNote,
    ...probeLossNote,
    '',
    '--------------------------------------------------------------------',
    '2. DIAGNÓSTICO INTELIGENTE',
    '--------------------------------------------------------------------',
    `Classificação   : ${diagnosis.title}`,
    `Resumo          : ${diagnosis.summary}`,
    `Observado       : ${diagnosis.observed}`,
    `Significado     : ${diagnosis.meaning}`,
    'Causas Prováveis (Hipóteses):',
    ...diagnosis.probableCauses.map((c) => `  - ${c}`),
    'Ações Recomendadas:',
    ...diagnosis.userActions.map((a) => `  - ${a}`),
    `Teste Adicional : ${diagnosis.confirmatoryTest}`,
    '',
    '--------------------------------------------------------------------',
    '3. AVALIAÇÃO GAMING (ORIENTATIVA)',
    '--------------------------------------------------------------------',
    `Parecer         : ${gaming.badge} — ${gaming.title}`,
    `Observação      : ${gaming.summary}`,
    `Nota            : ${gamingRouteNote}`,
    '===================================================================='
  ];

  return lines.join('\n');
}
