/**
 * Micro-servidor de medição TestAi 100% em RAM (zero dependências externas e zero I/O em disco).
 * Exporta `createMeasurementServer` para testes/embedding e inicia automaticamente quando
 * executado diretamente via `node server/index.js`.
 */

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createRateLimiter,
  LOOKING_GLASS_PRESETS,
  LookingGlassError,
  probeTcpLatency,
  resolveSafeTarget
} from './looking-glass.js';
import { createMetricsRegistry, isValidMetricsAuth } from './metrics.js';

const RAM_CHUNK_BYTES = 1024 * 1024; // 1 MiB pré-alocado no boot
const DEFAULT_MAX_DOWNLOAD_BYTES = 104_857_600; // 100 MB
const DEFAULT_MAX_UPLOAD_BYTES = 134_217_728; // 128 MB
const DEFAULT_MAX_STREAMS_PER_IP = 8; // 6 fluxos paralelos + 2 de margem para reconexão
const DEFAULT_MAX_GLOBAL_STREAMS = 64;
const STREAM_LIMIT_RETRY_AFTER_SEC = 2;
const DEFAULT_LOOKING_GLASS_BODY_BYTES = 2048; // 2 KB
const DEFAULT_LOOKING_GLASS_RATE_LIMIT = 10; // req/min por IP
const DEFAULT_LOOKING_GLASS_WINDOW_MS = 60_000;

// Preenchido uma única vez no boot com bytes aleatórios (evita compressão transparente de proxy/rede)
const RAM_CHUNK = crypto.randomBytes(RAM_CHUNK_BYTES);

function parsePositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

export function parseTrustProxy(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  return false;
}

export function normalizeClientIpString(raw) {
  if (typeof raw !== 'string') return '';
  let candidate = raw.trim();
  if (!candidate) return '';

  if (candidate.startsWith('[') && candidate.includes(']')) {
    candidate = candidate.slice(1, candidate.indexOf(']'));
  }

  if (candidate.toLowerCase().startsWith('::ffff:')) {
    const v4Candidate = candidate.slice(7);
    if (net.isIP(v4Candidate) === 4) {
      return v4Candidate;
    }
  }

  if (net.isIP(candidate) !== 0) {
    return candidate;
  }

  // Suporta formato IPv4:porta enviado por alguns proxies reversos
  const ipv4PortMatch = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4PortMatch && net.isIP(ipv4PortMatch[1]) === 4) {
    return ipv4PortMatch[1];
  }

  return '';
}

function isTrustedProxySocketIp(rawIp) {
  const ip = normalizeClientIpString(rawIp);
  if (!ip) return false;

  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 127) return true; // Loopback 127.0.0.0/8
    if (a === 10) return true; // RFC 1918 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918 172.16.0.0/12 (inclui bridge Docker)
    if (a === 192 && b === 168) return true; // RFC 1918 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT interno 100.64.0.0/10
    if (a === 169 && b === 254) return true; // Link-local 169.254.0.0/16
    return false;
  }

  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // Loopback IPv6
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
    if (
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    ) {
      return true; // Link-local fe80::/10
    }
    return false;
  }

  return false;
}

/**
 * Resolve o endereço IP real do cliente com proteção contra falsificação de cabeçalhos.
 * Só aceita `X-Real-IP` / `X-Forwarded-For` quando `trustProxy` está ativo E o socket
 * par pertence a loopback ou rede privada confiável (ex.: Nginx/Caddy local ou bridge Docker).
 *
 * @param {import('node:http').IncomingMessage | { headers?: Record<string, any>, socket?: { remoteAddress?: string } }} req
 * @param {{ trustProxy?: boolean | string }} [options]
 * @returns {string}
 */
export function resolveClientIp(req, options = {}) {
  const trustProxy = parseTrustProxy(options.trustProxy);
  const rawRemote = typeof req?.socket?.remoteAddress === 'string' ? req.socket.remoteAddress.trim() : '';
  const normalizedRemote = normalizeClientIpString(rawRemote) || rawRemote;

  const isTrustedProxyPeer = Boolean(rawRemote) && isTrustedProxySocketIp(rawRemote);
  if (trustProxy && isTrustedProxyPeer) {
    const headers = req?.headers || {};
    const realIpHeader = headers['x-real-ip'];
    const realIpRaw = Array.isArray(realIpHeader) ? realIpHeader[0] : realIpHeader;
    const validRealIp = normalizeClientIpString(realIpRaw);
    if (validRealIp) {
      return validRealIp;
    }

    const forwardedHeader = headers['x-forwarded-for'];
    const forwardedRaw = Array.isArray(forwardedHeader) ? forwardedHeader[0] : forwardedHeader;
    if (typeof forwardedRaw === 'string' && forwardedRaw.trim()) {
      const firstToken = forwardedRaw.split(',')[0].trim();
      const validForwardedIp = normalizeClientIpString(firstToken);
      if (validForwardedIp) {
        return validForwardedIp;
      }
    }
  }

  return normalizedRemote;
}

function sendJson(res, statusCode, payload, commonHeaders, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...commonHeaders,
    ...extraHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body))
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = DEFAULT_LOOKING_GLASS_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        chunks.length = 0;
        fail(
          new LookingGlassError(
            `Payload excede o limite de ${maxBytes} bytes.`,
            413,
            'PAYLOAD_TOO_LARGE'
          )
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (totalBytes === 0) {
        resolve({});
        return;
      }
      try {
        const text = Buffer.concat(chunks, totalBytes).toString('utf8');
        const parsed = JSON.parse(text);
        resolve(parsed);
      } catch {
        reject(new LookingGlassError('JSON inválido no corpo da requisição.', 400, 'INVALID_JSON'));
      }
    });

    req.on('error', () => {
      fail(new LookingGlassError('Erro ao ler corpo da requisição.', 400, 'READ_ERROR'));
    });
  });
}

function resolveMetricRoute(pathname, method) {
  if (method === 'OPTIONS') return 'options';
  if (pathname === '/api/ping') return 'ping';
  if (pathname === '/api/down') return 'download';
  if (pathname === '/api/up') return 'upload';
  if (pathname === '/api/meta') return 'meta';
  if (pathname === '/api/looking-glass/presets') return 'looking_glass_presets';
  if (pathname === '/api/looking-glass') return 'looking_glass';
  if (pathname === '/metrics') return 'metrics';
  return 'other';
}

/**
 * Cria o servidor HTTP nativo de medição para hospedagem self-hosted em ISPs.
 *
 * @param {{
 *   ispName?: string,
 *   serverLabel?: string,
 *   allowedOrigin?: string,
 *   trustProxy?: boolean | string,
 *   maxDownloadBytes?: number,
 *   maxUploadBytes?: number,
 *   maxStreamsPerIp?: number,
 *   maxGlobalStreams?: number,
 *   lookingGlassRateLimit?: number,
 *   lookingGlassWindowMs?: number,
 *   lookingGlassLookup?: (host: string, opts: any) => Promise<any>,
 *   lookingGlassProbe?: typeof probeTcpLatency,
 *   metricsEnabled?: boolean | string,
 *   metricsToken?: string,
 *   metricsRegistry?: ReturnType<typeof createMetricsRegistry>
 * }} [options]
 */
export function createMeasurementServer(options = {}) {
  const ispName =
    typeof (options.ispName ?? process.env.ISP_NAME) === 'string' &&
    (options.ispName ?? process.env.ISP_NAME).trim()
      ? (options.ispName ?? process.env.ISP_NAME).trim()
      : 'TestAi';

  const serverLabel =
    typeof (options.serverLabel ?? process.env.SERVER_LABEL) === 'string' &&
    (options.serverLabel ?? process.env.SERVER_LABEL).trim()
      ? (options.serverLabel ?? process.env.SERVER_LABEL).trim()
      : 'On-Net Server';

  const allowedOrigin =
    typeof (options.allowedOrigin ?? process.env.ALLOWED_ORIGIN) === 'string' &&
    (options.allowedOrigin ?? process.env.ALLOWED_ORIGIN).trim()
      ? (options.allowedOrigin ?? process.env.ALLOWED_ORIGIN).trim()
      : '*';

  const trustProxy = parseTrustProxy(options.trustProxy ?? process.env.TRUST_PROXY);

  const maxDownloadBytes = parsePositiveInt(
    options.maxDownloadBytes ?? process.env.MAX_DOWNLOAD_BYTES,
    DEFAULT_MAX_DOWNLOAD_BYTES
  );
  const maxUploadBytes = parsePositiveInt(
    options.maxUploadBytes ?? process.env.MAX_UPLOAD_BYTES,
    DEFAULT_MAX_UPLOAD_BYTES
  );
  const maxStreamsPerIp = parsePositiveInt(
    options.maxStreamsPerIp ?? process.env.MAX_STREAMS_PER_IP,
    DEFAULT_MAX_STREAMS_PER_IP
  );
  const maxGlobalStreams = parsePositiveInt(
    options.maxGlobalStreams ?? process.env.MAX_GLOBAL_STREAMS,
    DEFAULT_MAX_GLOBAL_STREAMS
  );

  let activeGlobalStreams = 0;
  /** @type {Map<string, number>} */
  const activeStreamsByIp = new Map();

  const acquireStreamSlot = (clientIp, req, res) => {
    const ipKey = typeof clientIp === 'string' && clientIp.trim() ? clientIp.trim() : 'unknown';
    const currentIpStreams = activeStreamsByIp.get(ipKey) || 0;

    if (currentIpStreams >= maxStreamsPerIp) {
      return {
        allowed: false,
        statusCode: 429,
        code: 'TOO_MANY_STREAMS_PER_IP',
        error: `Limite de ${maxStreamsPerIp} fluxos simultâneos por IP atingido.`,
        retryAfterSec: STREAM_LIMIT_RETRY_AFTER_SEC
      };
    }

    if (activeGlobalStreams >= maxGlobalStreams) {
      return {
        allowed: false,
        statusCode: 503,
        code: 'SERVER_BUSY',
        error: 'Capacidade máxima de fluxos simultâneos do nó de medição atingida.',
        retryAfterSec: STREAM_LIMIT_RETRY_AFTER_SEC + 1
      };
    }

    activeGlobalStreams += 1;
    activeStreamsByIp.set(ipKey, currentIpStreams + 1);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeGlobalStreams = Math.max(0, activeGlobalStreams - 1);
      const nextIpCount = (activeStreamsByIp.get(ipKey) || 1) - 1;
      if (nextIpCount <= 0) {
        activeStreamsByIp.delete(ipKey);
      } else {
        activeStreamsByIp.set(ipKey, nextIpCount);
      }
    };

    req.once('aborted', release);
    req.once('close', release);
    req.once('error', release);
    res.once('close', release);
    res.once('error', release);
    res.once('finish', release);

    return { allowed: true, release };
  };

  const rawMetricsEnabled = options.metricsEnabled ?? process.env.METRICS_ENABLED;
  const metricsEnabled = !(
    rawMetricsEnabled === false ||
    String(rawMetricsEnabled ?? '').trim().toLowerCase() === 'false' ||
    String(rawMetricsEnabled ?? '').trim() === '0'
  );
  const rawMetricsToken = options.metricsToken ?? process.env.METRICS_TOKEN;
  const metricsToken =
    typeof rawMetricsToken === 'string' && rawMetricsToken.trim()
      ? rawMetricsToken.trim()
      : '';
  const metrics = options.metricsRegistry || createMetricsRegistry();

  const lookingGlassLimiter = createRateLimiter({
    maxRequests: parsePositiveInt(
      options.lookingGlassRateLimit ?? process.env.LOOKING_GLASS_RATE_LIMIT,
      DEFAULT_LOOKING_GLASS_RATE_LIMIT
    ),
    windowMs: parsePositiveInt(options.lookingGlassWindowMs, DEFAULT_LOOKING_GLASS_WINDOW_MS)
  });
  const lookingGlassLookup = options.lookingGlassLookup;
  const lookingGlassProbe =
    typeof options.lookingGlassProbe === 'function'
      ? options.lookingGlassProbe
      : probeTcpLatency;

  const commonHeaders = {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With, Authorization',
    'Access-Control-Expose-Headers': 'Server-Timing, X-TestAi-Route, Retry-After',
    'Access-Control-Max-Age': '86400',
    'Timing-Allow-Origin': allowedOrigin,
    'X-TestAi-Route': 'on-net'
  };

  return http.createServer((req, res) => {
    const reqStartNs = process.hrtime.bigint();
    const method = (req.method || 'GET').toUpperCase();
    let metricRoute = 'other';

    res.once('finish', () => {
      metrics.recordRequest(metricRoute, res.statusCode);
    });

    const trackActive = (routeName) => {
      metrics.incActive(routeName);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        metrics.decActive(routeName);
      };
      req.once('aborted', release);
      req.once('close', release);
      req.once('error', release);
      res.once('finish', release);
      res.once('close', release);
      res.once('error', release);
      return release;
    };

    if (method === 'OPTIONS') {
      metricRoute = 'options';
      res.writeHead(204, commonHeaders);
      res.end();
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(req.url || '/', 'http://localhost');
    } catch {
      metricRoute = 'invalid';
      sendJson(res, 400, { ok: false, error: 'URL inválida.' }, commonHeaders);
      return;
    }

    const pathname = parsedUrl.pathname;
    metricRoute = resolveMetricRoute(pathname, method);

    if (pathname === '/metrics' && method === 'GET') {
      if (!metricsEnabled) {
        sendJson(res, 404, { ok: false, error: 'Métricas desabilitadas.' }, commonHeaders);
        return;
      }

      if (metricsToken && !isValidMetricsAuth(req, metricsToken)) {
        sendJson(
          res,
          401,
          { ok: false, error: 'Autenticação Bearer inválida ou ausente.' },
          commonHeaders,
          { 'WWW-Authenticate': 'Bearer realm="testai-metrics"' }
        );
        return;
      }

      const body = metrics.renderPrometheus();
      res.writeHead(200, {
        ...commonHeaders,
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(body))
      });
      res.end(body);
      return;
    }

    if (pathname === '/api/ping' && (method === 'GET' || method === 'HEAD')) {
      const handlerDurMs = (Number(process.hrtime.bigint() - reqStartNs) / 1_000_000).toFixed(3);
      res.writeHead(204, {
        ...commonHeaders,
        'Cache-Control': 'no-store, no-cache',
        'Timing-Allow-Origin': '*',
        'Server-Timing': `app;dur=${handlerDurMs}`,
        'X-TestAi-Route': 'on-net'
      });
      res.end();
      return;
    }

    if (pathname === '/api/down' && method === 'GET') {
      const rawBytes = parsedUrl.searchParams.get('bytes');
      if (rawBytes === null || !/^\d+$/.test(rawBytes)) {
        sendJson(
          res,
          400,
          { ok: false, error: 'Parâmetro bytes inválido.' },
          commonHeaders
        );
        return;
      }

      const totalBytes = Number(rawBytes);
      if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > maxDownloadBytes) {
        sendJson(
          res,
          400,
          {
            ok: false,
            error: `Parâmetro bytes deve estar entre 0 e ${maxDownloadBytes}.`,
            maxDownloadBytes
          },
          commonHeaders
        );
        return;
      }

      if (totalBytes === 0) {
        const handlerDurMs = (Number(process.hrtime.bigint() - reqStartNs) / 1_000_000).toFixed(3);
        res.writeHead(200, {
          ...commonHeaders,
          'Cache-Control': 'no-store, no-cache',
          'Timing-Allow-Origin': '*',
          'Server-Timing': `app;dur=${handlerDurMs}`,
          'X-TestAi-Route': 'on-net',
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'identity',
          'Content-Length': '0'
        });
        res.end();
        return;
      }

      const clientIp = resolveClientIp(req, { trustProxy });
      const slot = acquireStreamSlot(clientIp, req, res);
      if (!slot.allowed) {
        sendJson(
          res,
          slot.statusCode,
          {
            ok: false,
            error: slot.error,
            code: slot.code,
            retryAfterSec: slot.retryAfterSec
          },
          commonHeaders,
          { 'Retry-After': String(slot.retryAfterSec) }
        );
        return;
      }

      const releaseMetricActive = trackActive('download');
      res.writeHead(200, {
        ...commonHeaders,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'identity',
        'Content-Length': String(totalBytes)
      });

      let sent = 0;
      let aborted = false;
      const markAborted = () => {
        aborted = true;
        slot.release();
        releaseMetricActive();
      };
      req.once('aborted', markAborted);
      req.once('close', markAborted);
      res.once('close', markAborted);

      const writeNext = () => {
        if (aborted || res.destroyed || res.writableEnded) return;
        while (sent < totalBytes) {
          const remaining = totalBytes - sent;
          const chunk =
            remaining >= RAM_CHUNK_BYTES ? RAM_CHUNK : RAM_CHUNK.subarray(0, remaining);
          sent += chunk.length;
          metrics.addTransferBytes('download', chunk.length);
          const canContinue = res.write(chunk);
          if (!canContinue && sent < totalBytes) {
            res.once('drain', writeNext);
            return;
          }
        }
        if (!res.writableEnded) {
          req.removeListener('aborted', markAborted);
          req.removeListener('close', markAborted);
          res.removeListener('close', markAborted);
          res.end();
        }
      };

      writeNext();
      return;
    }

    if (pathname === '/api/up' && method === 'POST') {
      const clientIp = resolveClientIp(req, { trustProxy });
      const slot = acquireStreamSlot(clientIp, req, res);
      if (!slot.allowed) {
        sendJson(
          res,
          slot.statusCode,
          {
            ok: false,
            error: slot.error,
            code: slot.code,
            retryAfterSec: slot.retryAfterSec
          },
          commonHeaders,
          {
            'Retry-After': String(slot.retryAfterSec),
            Connection: 'close'
          }
        );
        return;
      }

      const releaseMetricActive = trackActive('upload');
      let receivedBytes = 0;
      let exceeded = false;
      let responded = false;

      const handleTooLarge = () => {
        if (responded) return;
        responded = true;
        exceeded = true;
        slot.release();
        releaseMetricActive();
        sendJson(
          res,
          413,
          {
            ok: false,
            error: `Payload excede o limite máximo de ${maxUploadBytes} bytes.`,
            maxUploadBytes
          },
          commonHeaders,
          { Connection: 'close' }
        );
      };

      // Consome chunks em streaming sem armazenar nem concatenar payload em RAM
      req.on('data', (chunk) => {
        receivedBytes += chunk.length;
        metrics.addTransferBytes('upload', chunk.length);
        if (!exceeded && receivedBytes > maxUploadBytes) {
          handleTooLarge();
        }
      });

      req.on('end', () => {
        if (exceeded || responded || res.writableEnded) return;
        responded = true;
        sendJson(res, 200, { ok: true, receivedBytes }, commonHeaders);
      });

      req.on('error', () => {
        slot.release();
        releaseMetricActive();
        if (!responded && !res.writableEnded) {
          responded = true;
          res.destroy();
        }
      });
      return;
    }

    if (pathname === '/api/meta' && method === 'GET') {
      const clientIp = resolveClientIp(req, { trustProxy });
      sendJson(res, 200, { ispName, serverLabel, clientIp }, commonHeaders);
      return;
    }

    if (pathname === '/api/looking-glass/presets' && method === 'GET') {
      sendJson(res, 200, { ok: true, presets: LOOKING_GLASS_PRESETS }, commonHeaders);
      return;
    }

    if (pathname === '/api/looking-glass' && method === 'POST') {
      const clientIp = resolveClientIp(req, { trustProxy });
      const rateState = lookingGlassLimiter.check(clientIp);
      if (!rateState.allowed) {
        metrics.recordLookingGlassOutcome('rate_limited');
        sendJson(
          res,
          429,
          {
            ok: false,
            error: 'Limite de consultas Looking Glass atingido. Tente novamente em instantes.',
            retryAfterSec: rateState.retryAfterSec
          },
          commonHeaders,
          { 'Retry-After': String(rateState.retryAfterSec) }
        );
        return;
      }

      const releaseLg = trackActive('looking_glass');
      readJsonBody(req, DEFAULT_LOOKING_GLASS_BODY_BYTES)
        .then(async (payload) => {
          const resolved = await resolveSafeTarget(payload, {
            lookupImpl: lookingGlassLookup
          });
          const probeResult = await lookingGlassProbe(resolved.resolvedIp, resolved.port, {
            count: 4,
            timeoutMs: 2000,
            target: resolved.target
          });
          metrics.recordLookingGlassOutcome('ok');
          releaseLg();
          if (!res.writableEnded) {
            sendJson(res, 200, { ok: true, ...probeResult }, commonHeaders);
          }
        })
        .catch((err) => {
          releaseLg();
          if (res.writableEnded) return;
          if (err instanceof LookingGlassError) {
            metrics.recordLookingGlassOutcome(
              err.code === 'SSRF_BLOCKED' || err.statusCode === 403 ? 'blocked' : 'error'
            );
            const extraHeaders = err.statusCode === 413 ? { Connection: 'close' } : {};
            sendJson(
              res,
              err.statusCode,
              { ok: false, error: err.message, code: err.code },
              commonHeaders,
              extraHeaders
            );
            return;
          }
          metrics.recordLookingGlassOutcome('error');
          sendJson(
            res,
            500,
            { ok: false, error: 'Erro interno ao executar sonda Looking Glass.' },
            commonHeaders
          );
        });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Rota não encontrada.' }, commonHeaders);
  });
}

const isDirectExecution =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  const port = parsePositiveInt(process.env.PORT, 3001);
  const host =
    typeof process.env.HOST === 'string' && process.env.HOST.trim()
      ? process.env.HOST.trim()
      : '0.0.0.0';

  const server = createMeasurementServer();
  server.listen(port, host, () => {
    console.log(`[TestAi Server] Ouvindo em http://${host}:${port} (modo RAM puro)`);
  });
}
