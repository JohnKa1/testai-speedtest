/**
 * Coletores leves em memória e expositor Prometheus (texto 0.0.4) sem dependências externas.
 */

import crypto from 'node:crypto';

const ACTIVE_ROUTES = ['download', 'upload', 'looking_glass'];
const DIRECTIONS = ['download', 'upload'];
const LG_OUTCOMES = ['ok', 'blocked', 'rate_limited', 'error'];

function escapeLabelValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function sha256Digest(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest();
}

/**
 * Valida cabeçalho `Authorization: Bearer <token>` em tempo constante.
 *
 * @param {{ headers?: Record<string, string | string[] | undefined> }} req
 * @param {string} expectedToken
 * @returns {boolean}
 */
export function isValidMetricsAuth(req, expectedToken) {
  if (typeof expectedToken !== 'string' || !expectedToken) {
    return false;
  }

  const rawHeader = req?.headers?.authorization;
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof headerValue !== 'string') {
    return false;
  }

  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) {
    return false;
  }

  const providedHash = sha256Digest(match[1].trim());
  const expectedHash = sha256Digest(expectedToken);
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

/**
 * Cria o registro em memória de métricas Prometheus do servidor TestAi.
 *
 * @param {{
 *   startedAtMs?: number,
 *   nowFn?: () => number,
 *   memoryUsageFn?: () => { rss?: number }
 * }} [options]
 */
export function createMetricsRegistry(options = {}) {
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
  const startedAtMs = Number.isFinite(options.startedAtMs) ? options.startedAtMs : nowFn();
  const memoryUsageFn =
    typeof options.memoryUsageFn === 'function' ? options.memoryUsageFn : () => process.memoryUsage();

  const activeRequests = new Map(ACTIVE_ROUTES.map((route) => [route, 0]));
  const transferBytes = new Map(DIRECTIONS.map((dir) => [dir, 0]));
  const lookingGlassProbes = new Map(LG_OUTCOMES.map((outcome) => [outcome, 0]));
  /** @type {Map<string, { route: string, status: string, count: number }>} */
  const requestsTotal = new Map();

  const incActive = (route) => {
    const key = String(route || 'other');
    activeRequests.set(key, (activeRequests.get(key) || 0) + 1);
  };

  const decActive = (route) => {
    const key = String(route || 'other');
    const current = activeRequests.get(key) || 0;
    activeRequests.set(key, Math.max(0, current - 1));
  };

  const recordRequest = (route, statusCode) => {
    const safeRoute = String(route || 'other');
    const safeStatus = String(Number.isInteger(statusCode) ? statusCode : 0);
    const mapKey = `${safeRoute}|${safeStatus}`;
    const existing = requestsTotal.get(mapKey);
    if (existing) {
      existing.count += 1;
    } else {
      requestsTotal.set(mapKey, { route: safeRoute, status: safeStatus, count: 1 });
    }
  };

  const addTransferBytes = (direction, bytes) => {
    const num = Number(bytes);
    if (!Number.isFinite(num) || num <= 0) return;
    const key = direction === 'upload' ? 'upload' : 'download';
    transferBytes.set(key, (transferBytes.get(key) || 0) + num);
  };

  const recordLookingGlassOutcome = (outcome) => {
    const normalized = LG_OUTCOMES.includes(outcome) ? outcome : 'error';
    lookingGlassProbes.set(normalized, (lookingGlassProbes.get(normalized) || 0) + 1);
  };

  const renderPrometheus = () => {
    const uptimeSeconds = Math.max(0, (nowFn() - startedAtMs) / 1000);
    let rssBytes = 0;
    try {
      const usage = memoryUsageFn();
      rssBytes = Number.isFinite(usage?.rss) ? Number(usage.rss) : 0;
    } catch {
      rssBytes = 0;
    }

    const lines = [];

    lines.push('# HELP testai_uptime_seconds Tempo de atividade do processo em segundos.');
    lines.push('# TYPE testai_uptime_seconds gauge');
    lines.push(`testai_uptime_seconds ${uptimeSeconds.toFixed(3)}`);

    lines.push(
      '# HELP testai_process_resident_memory_bytes Memória residente (RSS) ocupada pelo processo Node.js em bytes.'
    );
    lines.push('# TYPE testai_process_resident_memory_bytes gauge');
    lines.push(`testai_process_resident_memory_bytes ${Math.round(rssBytes)}`);

    lines.push('# HELP testai_active_requests Requisições ativas atualmente em execução por rota.');
    lines.push('# TYPE testai_active_requests gauge');
    for (const [route, count] of activeRequests.entries()) {
      lines.push(`testai_active_requests{route="${escapeLabelValue(route)}"} ${count}`);
    }

    lines.push('# HELP testai_requests_total Total de requisições HTTP atendidas por rota e status.');
    lines.push('# TYPE testai_requests_total counter');
    if (requestsTotal.size === 0) {
      lines.push('testai_requests_total{route="ping",status="204"} 0');
    } else {
      for (const entry of requestsTotal.values()) {
        lines.push(
          `testai_requests_total{route="${escapeLabelValue(entry.route)}",status="${escapeLabelValue(entry.status)}"} ${entry.count}`
        );
      }
    }

    lines.push(
      '# HELP testai_transfer_bytes_total Total acumulado de bytes transferidos em medições de download e upload.'
    );
    lines.push('# TYPE testai_transfer_bytes_total counter');
    for (const [direction, total] of transferBytes.entries()) {
      lines.push(`testai_transfer_bytes_total{direction="${escapeLabelValue(direction)}"} ${total}`);
    }

    lines.push(
      '# HELP testai_looking_glass_probes_total Total de sondas TCP Looking Glass agrupadas por desfecho.'
    );
    lines.push('# TYPE testai_looking_glass_probes_total counter');
    for (const [outcome, total] of lookingGlassProbes.entries()) {
      lines.push(`testai_looking_glass_probes_total{outcome="${escapeLabelValue(outcome)}"} ${total}`);
    }

    return `${lines.join('\n')}\n`;
  };

  return {
    incActive,
    decActive,
    recordRequest,
    addTransferBytes,
    recordLookingGlassOutcome,
    renderPrometheus
  };
}
