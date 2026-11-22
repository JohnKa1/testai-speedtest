/**
 * Persistência local de testes, comparação entre execuções e geração de relatórios
 * técnicos exportáveis (JSON, CSV e TXT).
 */

import { isNonNegativeNumber } from '../utils/validators.js';
import {
  formatBytes,
  formatDateTime,
  formatDeltaMs,
  formatDuration,
  formatLatency,
  formatSpeed
} from '../utils/formatters.js';

const STORAGE_KEY = 'testai_history_v2';
const MAX_RECORDS = 100;

export function loadHistory(storage = window.localStorage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.id === 'string');
  } catch {
    return [];
  }
}

export function saveHistory(records, storage = window.localStorage) {
  try {
    const trimmed = Array.isArray(records) ? records.slice(0, MAX_RECORDS) : [];
    storage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import('../types.js').SpeedTestResult} result
 * @param {import('../types.js').DiagnosisResult} diagnosis
 * @param {import('../types.js').GamingResult} gaming
 * @returns {import('../types.js').HistoryRecord}
 */
export function toHistoryRecord(result, diagnosis, gaming) {
  const m = result.metrics;
  return {
    id: result.id,
    timestamp: result.timestamp,
    incomplete: Boolean(result.incomplete),
    durationMs: result.durationMs,
    profileLabel: result.profile?.label || 'Padrão',
    context: result.context || {},
    downloadMbps: m.download?.value ?? null,
    uploadMbps: m.upload?.value ?? null,
    pingMs: m.ping?.value ?? null,
    jitterMs: m.jitter?.value ?? null,
    downloadLatencyMs: m.downloadLatency?.value ?? null,
    uploadLatencyMs: m.uploadLatency?.value ?? null,
    downloadLatencyDeltaMs: m.downloadLatencyDelta?.value ?? null,
    uploadLatencyDeltaMs: m.uploadLatencyDelta?.value ?? null,
    downloadJitterMs: m.downloadJitter?.value ?? null,
    uploadJitterMs: m.uploadJitter?.value ?? null,
    totalBytes: result.transfer?.totalBytes ?? null,
    diagnosisCode: diagnosis?.code || 'inconclusive',
    diagnosisTitle: diagnosis?.title || 'Sem diagnóstico',
    diagnosisSummary: diagnosis?.summary || '',
    gamingBadge: gaming?.badge || 'N/D'
  };
}

export function appendHistoryRecord(record, storage = window.localStorage) {
  const current = loadHistory(storage);
  const updated = [record, ...current.filter((r) => r.id !== record.id)].slice(0, MAX_RECORDS);
  saveHistory(updated, storage);
  return updated;
}

export function deleteHistoryRecord(id, storage = window.localStorage) {
  const current = loadHistory(storage);
  const updated = current.filter((r) => r.id !== id);
  saveHistory(updated, storage);
  return updated;
}

export function clearHistory(storage = window.localStorage) {
  saveHistory([], storage);
  return [];
}

/**
 * Compara duas execuções salvas (mais recente vs. anterior).
 */
export function compareHistoryRecords(newer, older) {
  if (!newer || !older) return null;

  const diff = (a, b) =>
    isNonNegativeNumber(a) && isNonNegativeNumber(b) ? a - b : null;

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
  return JSON.stringify(
    {
      application: 'TestAi Network Diagnostics',
      exportedAt: new Date().toISOString(),
      count: records.length,
      records
    },
    null,
    2
  );
}

export function exportHistoryCsv(records) {
  const headers = [
    'id',
    'timestamp',
    'profile',
    'link_type',
    'download_mbps',
    'upload_mbps',
    'ping_ms',
    'jitter_ms',
    'download_loaded_ms',
    'upload_loaded_ms',
    'delta_download_ms',
    'delta_upload_ms',
    'diagnosis'
  ];

  const escapeCsv = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = records.map((r) =>
    [
      r.id,
      r.timestamp,
      r.profileLabel,
      r.context?.linkType || '',
      r.downloadMbps ?? '',
      r.uploadMbps ?? '',
      r.pingMs ?? '',
      r.jitterMs ?? '',
      r.downloadLatencyMs ?? '',
      r.uploadLatencyMs ?? '',
      r.downloadLatencyDeltaMs ?? '',
      r.uploadLatencyDeltaMs ?? '',
      r.diagnosisTitle
    ]
      .map(escapeCsv)
      .join(',')
  );

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Gera laudo técnico completo em texto puro para suporte, NOC ou provedor.
 * @param {import('../types.js').SpeedTestResult} result
 * @param {import('../types.js').DiagnosisResult} diagnosis
 * @param {import('../types.js').GamingResult} gaming
 * @param {string} [notes]
 * @returns {string}
 */
export function buildTechnicalReportTxt(result, diagnosis, gaming, notes = '') {
  const m = result.metrics;
  const dlP50Note = isNonNegativeNumber(result.stats?.download?.p50)
    ? ` · P50: ${result.stats.download.p50.toFixed(1)} Mbps`
    : '';
  const ulP50Note = isNonNegativeNumber(result.stats?.upload?.p50)
    ? ` · P50: ${result.stats.upload.p50.toFixed(1)} Mbps`
    : '';

  const lines = [
    '====================================================================',
    'TESTAI — LAUDO TÉCNICO DE DIAGNÓSTICO DE REDE',
    '====================================================================',
    `Sessão ID       : ${result.id}`,
    `Data / Hora     : ${formatDateTime(result.timestamp)}`,
    `Destino de Teste: Cloudflare Edge (HTTP/TLS Anycast)`,
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
    `Download (Média)      : ${formatSpeed(m.download?.value, 1, m.download?.status)} Mbps${dlP50Note}`,
    `Upload (Média)        : ${formatSpeed(m.upload?.value, 1, m.upload?.status)} Mbps${ulP50Note}`,
    `Latência Ociosa (P50) : ${formatLatency(m.ping?.value, 0, m.ping?.status)} ms`,
    `Jitter Ocioso         : ${formatLatency(m.jitter?.value, 1, m.jitter?.status)} ms`,
    `Latência sob Download : ${formatLatency(m.downloadLatency?.value, 0, m.downloadLatency?.status)} ms (${formatDeltaMs(m.downloadLatencyDelta?.value)})`,
    `Latência sob Upload   : ${formatLatency(m.uploadLatency?.value, 0, m.uploadLatency?.status)} ms (${formatDeltaMs(m.uploadLatencyDelta?.value)})`,
    `Jitter sob Download   : ${formatLatency(m.downloadJitter?.value, 1, m.downloadJitter?.status)} ms`,
    `Jitter sob Upload     : ${formatLatency(m.uploadJitter?.value, 1, m.uploadJitter?.status)} ms`,
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
    'Nota            : Medição referente à borda Cloudflare; não representa ping direto a servidores específicos de jogos.',
    '===================================================================='
  ];

  return lines.join('\n');
}