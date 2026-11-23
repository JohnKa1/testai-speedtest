/**
 * Módulo de Looking Glass TCP seguro para o servidor self-hosted do TestAi.
 * Implementa presets oficiais, trava Anti-SSRF (IPv4/IPv6 + proteção contra DNS rebinding),
 * rate limiter em memória e sonda TCP sequencial leve sem dependências externas.
 */

import net from 'node:net';
import dns from 'node:dns/promises';

export const ALLOWED_LOOKING_GLASS_PORTS = Object.freeze([80, 443]);

export const LOOKING_GLASS_PRESETS = Object.freeze([
  Object.freeze({
    id: 'cloudflare',
    label: 'Cloudflare DNS',
    host: '1.1.1.1',
    port: 443
  }),
  Object.freeze({
    id: 'google',
    label: 'Google DNS',
    host: '8.8.8.8',
    port: 443
  }),
  Object.freeze({
    id: 'aws-sp',
    label: 'AWS São Paulo',
    host: 'ec2.sa-east-1.amazonaws.com',
    port: 443
  }),
  Object.freeze({
    id: 'riot-br',
    label: 'Rota Jogos SP / SA-East',
    host: 'dynamodb.sa-east-1.amazonaws.com',
    port: 443
  })
]);

const FQDN_REGEX =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export class LookingGlassError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode]
   * @param {string} [code]
   */
  constructor(message, statusCode = 400, code = 'INVALID_REQUEST') {
    super(message);
    this.name = 'LookingGlassError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function parseIpv4Octets(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    octets.push(num);
  }
  return octets;
}

function isPrivateOrReservedIpv4Octets(octets) {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  if (a === 10) return true; // 10.0.0.0/8 (RFC 1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT RFC 6598)
  if (a === 127) return true; // 127.0.0.0/8 (Loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-local / Cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC 1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF Protocol)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC 1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 Multicast & 240.0.0.0/4 Reserved/Broadcast
  return false;
}

function parseHexGroup(hex) {
  if (!/^[0-9a-fA-F]{1,4}$/.test(hex)) return null;
  return parseInt(hex, 16);
}

function expandIpv6Groups(ip) {
  if (ip.includes('%')) return null;

  let working = ip.toLowerCase();
  const lastColon = working.lastIndexOf(':');
  if (working.includes('.')) {
    if (lastColon === -1) return null;
    const v4Part = working.slice(lastColon + 1);
    const octets = parseIpv4Octets(v4Part);
    if (!octets) return null;
    const highHex = ((octets[0] << 8) | octets[1]).toString(16);
    const lowHex = ((octets[2] << 8) | octets[3]).toString(16);
    working = `${working.slice(0, lastColon + 1)}${highHex}:${lowHex}`;
  }

  const dblSplit = working.split('::');
  if (dblSplit.length > 2) return null;

  const parseSegmentList = (seg) => {
    if (seg === '') return [];
    const parts = seg.split(':');
    const out = [];
    for (const part of parts) {
      const val = parseHexGroup(part);
      if (val === null) return null;
      out.push(val);
    }
    return out;
  };

  if (dblSplit.length === 1) {
    const groups = parseSegmentList(dblSplit[0]);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseSegmentList(dblSplit[0]);
  const right = parseSegmentList(dblSplit[1]);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;

  return [...left, ...Array(missing).fill(0), ...right];
}

/**
 * Verifica se um endereço IPv4 ou IPv6 pertence a faixas privadas, loopback,
 * CGNAT, link-local, multicast, IPv4-mapped IPv6 ou reservadas (fail-closed).
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateOrReservedIp(ip) {
  if (typeof ip !== 'string') return true;
  const trimmed = ip.trim();
  if (!trimmed || trimmed.includes('%')) return true;

  const family = net.isIP(trimmed);
  if (family === 4) {
    const octets = parseIpv4Octets(trimmed);
    return !octets || isPrivateOrReservedIpv4Octets(octets);
  }

  if (family === 6) {
    const g = expandIpv6Groups(trimmed);
    if (!g) return true;

    const allZeroPrefix = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;

    // ::/128 (unspecified) e ::1/128 (loopback)
    if (allZeroPrefix && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) {
      return true;
    }

    // ::/96 (IPv4-compatible IPv6) e ::ffff:0:0/96 (IPv4-mapped IPv6)
    if (allZeroPrefix && (g[5] === 0 || g[5] === 0xffff)) {
      return true;
    }

    // fc00::/7 (Unique Local Address)
    if ((g[0] & 0xfe00) === 0xfc00) return true;

    // fe80::/10 (Link-local) e fec0::/10 (Site-local legado)
    if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true;

    // ff00::/8 (Multicast)
    if ((g[0] & 0xff00) === 0xff00) return true;

    // 2001:db8::/32 (Documentação) e 100::/64 (Discard-only)
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;

    // NAT64 (64:ff9b::/96 e 64:ff9b:1::/48)
    const isNat64 =
      g[0] === 0x0064 &&
      g[1] === 0xff9b &&
      ((g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) || g[2] === 0x0001);
    if (isNat64) {
      const embeddedOctets = [
        (g[6] >>> 8) & 0xff,
        g[6] & 0xff,
        (g[7] >>> 8) & 0xff,
        g[7] & 0xff
      ];
      return isPrivateOrReservedIpv4Octets(embeddedOctets);
    }

    return false;
  }

  return true;
}

/**
 * Valida o alvo da sonda Looking Glass (`presetId` oficial ou `{ host, port }`).
 *
 * @param {{ presetId?: string, host?: string, port?: number | string }} input
 * @returns {{ target: string, host: string, port: number, presetId: string | null }}
 */
export function validateLookingGlassTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new LookingGlassError('Payload de Looking Glass inválido.', 400, 'INVALID_PAYLOAD');
  }

  if (input.presetId !== undefined && input.presetId !== null && input.presetId !== '') {
    const rawPreset = typeof input.presetId === 'string' ? input.presetId.trim() : '';
    const preset = LOOKING_GLASS_PRESETS.find((item) => item.id === rawPreset);
    if (!preset) {
      throw new LookingGlassError('Preset de Looking Glass desconhecido.', 400, 'UNKNOWN_PRESET');
    }
    return {
      target: preset.host,
      host: preset.host,
      port: preset.port,
      presetId: preset.id
    };
  }

  const rawHost = typeof input.host === 'string' ? input.host.trim() : '';
  if (!rawHost) {
    throw new LookingGlassError('Host de destino é obrigatório.', 400, 'INVALID_HOST');
  }

  const port =
    input.port === undefined || input.port === null || input.port === ''
      ? 443
      : Number(input.port);
  if (!Number.isInteger(port) || !ALLOWED_LOOKING_GLASS_PORTS.includes(port)) {
    throw new LookingGlassError(
      'Porta não permitida. Apenas portas 80 e 443 são aceitas.',
      400,
      'INVALID_PORT'
    );
  }

  const ipFamily = net.isIP(rawHost);
  if (ipFamily === 0 && !FQDN_REGEX.test(rawHost)) {
    throw new LookingGlassError('Host inválido ou não permitido.', 400, 'INVALID_HOST');
  }

  return {
    target: rawHost,
    host: rawHost,
    port,
    presetId: null
  };
}

/**
 * Resolve e valida o endereço IP final antes da conexão TCP, bloqueando qualquer
 * faixa privada/reservada e evitando ataques de DNS rebinding.
 *
 * @param {{ presetId?: string, host?: string, port?: number | string }} input
 * @param {{ lookupImpl?: (host: string, opts: { all: true, verbatim: true }) => Promise<Array<{ address: string, family: number }> | { address: string, family: number }> }} [deps]
 * @returns {Promise<{ target: string, resolvedIp: string, family: number, port: number, presetId: string | null }>}
 */
export async function resolveSafeTarget(input, { lookupImpl = dns.lookup } = {}) {
  const validated = validateLookingGlassTarget(input);
  const literalFamily = net.isIP(validated.host);

  if (literalFamily !== 0) {
    if (isPrivateOrReservedIp(validated.host)) {
      throw new LookingGlassError(
        'Alvo bloqueado pela política Anti-SSRF (IP privado ou reservado).',
        403,
        'SSRF_BLOCKED'
      );
    }
    return {
      target: validated.target,
      resolvedIp: validated.host,
      family: literalFamily,
      port: validated.port,
      presetId: validated.presetId
    };
  }

  let records;
  try {
    const rawResult = await lookupImpl(validated.host, { all: true, verbatim: true });
    records = Array.isArray(rawResult) ? rawResult : rawResult ? [rawResult] : [];
  } catch {
    throw new LookingGlassError(
      'Não foi possível resolver o DNS do host informado.',
      400,
      'DNS_RESOLUTION_FAILED'
    );
  }

  if (records.length === 0) {
    throw new LookingGlassError(
      'Nenhum registro DNS válido encontrado para o host informado.',
      400,
      'DNS_RESOLUTION_FAILED'
    );
  }

  for (const record of records) {
    if (!record?.address || isPrivateOrReservedIp(record.address)) {
      throw new LookingGlassError(
        'Destino bloqueado pela política Anti-SSRF (DNS resolveu para IP privado ou reservado).',
        403,
        'SSRF_BLOCKED'
      );
    }
  }

  const chosen = records.find((r) => net.isIP(r.address) === 4) || records[0];
  return {
    target: validated.target,
    resolvedIp: chosen.address,
    family: net.isIP(chosen.address) || chosen.family || 4,
    port: validated.port,
    presetId: validated.presetId
  };
}

function measureSingleTcpConnect(ip, port, timeoutMs, connectImpl) {
  return new Promise((resolve) => {
    const family = net.isIP(ip) || undefined;
    const startNs = process.hrtime.bigint();
    let settled = false;
    let fallbackTimer = null;

    let socket;
    const finish = (sampleMs) => {
      if (settled) return;
      settled = true;
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (socket) {
        socket.removeAllListeners?.();
        socket.destroy?.();
      }
      resolve(sampleMs);
    };

    try {
      socket = connectImpl({ host: ip, port, family });
    } catch {
      finish(null);
      return;
    }

    if (typeof socket.setTimeout === 'function') {
      socket.setTimeout(timeoutMs);
    }

    fallbackTimer = globalThis.setTimeout(() => finish(null), timeoutMs + 50);

    socket.once('connect', () => {
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      finish(roundMs(Math.max(0.01, elapsedMs)));
    });

    socket.once('timeout', () => finish(null));
    socket.once('error', () => finish(null));
  });
}

/**
 * Executa sondas TCP sequenciais curtas diretamente no IP validado.
 *
 * @param {string} ip
 * @param {number} port
 * @param {{
 *   count?: number,
 *   timeoutMs?: number,
 *   target?: string,
 *   connectImpl?: typeof net.createConnection
 * }} [options]
 * @returns {Promise<{
 *   target: string,
 *   resolvedIp: string,
 *   port: number,
 *   samplesMs: number[],
 *   minMs: number | null,
 *   avgMs: number | null,
 *   maxMs: number | null,
 *   jitterMs: number | null,
 *   packetLossPct: number
 * }>}
 */
export async function probeTcpLatency(ip, port, options = {}) {
  const safeCount = Math.max(1, Math.min(10, Math.floor(Number(options.count) || 4)));
  const safeTimeoutMs = Math.max(100, Math.min(10_000, Math.floor(Number(options.timeoutMs) || 2000)));
  const target = typeof options.target === 'string' && options.target ? options.target : ip;
  const connectImpl = options.connectImpl || net.createConnection;

  const samplesMs = [];
  for (let i = 0; i < safeCount; i += 1) {
    const rttMs = await measureSingleTcpConnect(ip, port, safeTimeoutMs, connectImpl);
    if (rttMs !== null) {
      samplesMs.push(rttMs);
    }
  }

  let minMs = null;
  let avgMs = null;
  let maxMs = null;
  let jitterMs = null;

  if (samplesMs.length > 0) {
    minMs = roundMs(Math.min(...samplesMs));
    maxMs = roundMs(Math.max(...samplesMs));
    const sum = samplesMs.reduce((acc, v) => acc + v, 0);
    avgMs = roundMs(sum / samplesMs.length);
  }

  if (samplesMs.length >= 2) {
    let jitterSum = 0;
    for (let i = 1; i < samplesMs.length; i += 1) {
      jitterSum += Math.abs(samplesMs[i] - samplesMs[i - 1]);
    }
    jitterMs = roundMs(jitterSum / (samplesMs.length - 1));
  }

  const lost = safeCount - samplesMs.length;
  const packetLossPct = Math.round((lost / safeCount) * 10_000) / 100;

  return {
    target,
    resolvedIp: ip,
    port,
    samplesMs,
    minMs,
    avgMs,
    maxMs,
    jitterMs,
    packetLossPct
  };
}

/**
 * Cria um rate limiter em memória com expiração e poda periódica para evitar vazamento de RAM.
 *
 * @param {{ maxRequests?: number, windowMs?: number, nowFn?: () => number }} [options]
 */
export function createRateLimiter(options = {}) {
  const maxRequests = Math.max(1, Math.floor(Number(options.maxRequests) || 10));
  const windowMs = Math.max(1000, Math.floor(Number(options.windowMs) || 60_000));
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;

  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();
  let lastPruneAt = nowFn();

  const prune = (now = nowFn()) => {
    for (const [key, entry] of buckets.entries()) {
      if (now >= entry.resetAt) {
        buckets.delete(key);
      }
    }
    lastPruneAt = now;
  };

  /**
   * @param {string} clientKey
   */
  const check = (clientKey) => {
    const key = typeof clientKey === 'string' && clientKey.trim() ? clientKey.trim() : 'unknown';
    const now = nowFn();

    if (now - lastPruneAt >= windowMs || buckets.size > 1000) {
      prune(now);
    }

    const existing = buckets.get(key);
    if (!existing || now >= existing.resetAt) {
      const entry = { count: 1, resetAt: now + windowMs };
      buckets.set(key, entry);
      return {
        allowed: true,
        remaining: Math.max(0, maxRequests - 1),
        limit: maxRequests,
        resetAt: entry.resetAt,
        retryAfterSec: 0
      };
    }

    if (existing.count >= maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      return {
        allowed: false,
        remaining: 0,
        limit: maxRequests,
        resetAt: existing.resetAt,
        retryAfterSec
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - existing.count),
      limit: maxRequests,
      resetAt: existing.resetAt,
      retryAfterSec: 0
    };
  };

  return {
    check,
    prune,
    size: () => buckets.size
  };
}
