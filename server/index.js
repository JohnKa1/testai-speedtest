/**
 * Micro-servidor de medição TestAi 100% em RAM (zero dependências externas e zero I/O em disco).
 * Exporta `createMeasurementServer` para testes/embedding e inicia automaticamente quando
 * executado diretamente via `node server/index.js`.
 */

import http from 'node:http';
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

const RAM_CHUNK_BYTES = 1024 * 1024; // 1 MiB pré-alocado no boot
const DEFAULT_MAX_DOWNLOAD_BYTES = 104_857_600; // 100 MB
const DEFAULT_MAX_UPLOAD_BYTES = 134_217_728; // 128 MB
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

function resolveClientIp(req) {
  const realIpHeader = req.headers['x-real-ip'];
  const realIp = Array.isArray(realIpHeader) ? realIpHeader[0] : realIpHeader;
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }

  const forwardedHeader = req.headers['x-forwarded-for'];
  const forwardedRaw = Array.isArray(forwardedHeader) ? forwardedHeader[0] : forwardedHeader;
  if (typeof forwardedRaw === 'string' && forwardedRaw.trim()) {
    const firstIp = forwardedRaw.split(',')[0].trim();
    if (firstIp) return firstIp;
  }

  return req.socket?.remoteAddress || '';
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

/**
 * Cria o servidor HTTP nativo de medição para hospedagem self-hosted em ISPs.
 *
 * @param {{
 *   ispName?: string,
 *   serverLabel?: string,
 *   allowedOrigin?: string,
 *   maxDownloadBytes?: number,
 *   maxUploadBytes?: number,
 *   lookingGlassRateLimit?: number,
 *   lookingGlassWindowMs?: number,
 *   lookingGlassLookup?: (host: string, opts: any) => Promise<any>,
 *   lookingGlassProbe?: typeof probeTcpLatency
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

  const maxDownloadBytes = parsePositiveInt(
    options.maxDownloadBytes ?? process.env.MAX_DOWNLOAD_BYTES,
    DEFAULT_MAX_DOWNLOAD_BYTES
  );
  const maxUploadBytes = parsePositiveInt(
    options.maxUploadBytes ?? process.env.MAX_UPLOAD_BYTES,
    DEFAULT_MAX_UPLOAD_BYTES
  );

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
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Timing-Allow-Origin': allowedOrigin
  };

  return http.createServer((req, res) => {
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      res.writeHead(204, commonHeaders);
      res.end();
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(req.url || '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { ok: false, error: 'URL inválida.' }, commonHeaders);
      return;
    }

    const pathname = parsedUrl.pathname;

    if (pathname === '/api/ping' && (method === 'GET' || method === 'HEAD')) {
      res.writeHead(204, commonHeaders);
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

      res.writeHead(200, {
        ...commonHeaders,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'identity',
        'Content-Length': String(totalBytes)
      });

      if (totalBytes === 0) {
        res.end();
        return;
      }

      let sent = 0;
      let aborted = false;
      const markAborted = () => {
        aborted = true;
      };
      req.once('close', markAborted);
      res.once('close', markAborted);

      const writeNext = () => {
        if (aborted || res.destroyed || res.writableEnded) return;
        while (sent < totalBytes) {
          const remaining = totalBytes - sent;
          const chunk =
            remaining >= RAM_CHUNK_BYTES ? RAM_CHUNK : RAM_CHUNK.subarray(0, remaining);
          sent += chunk.length;
          const canContinue = res.write(chunk);
          if (!canContinue && sent < totalBytes) {
            res.once('drain', writeNext);
            return;
          }
        }
        if (!res.writableEnded) {
          req.removeListener('close', markAborted);
          res.removeListener('close', markAborted);
          res.end();
        }
      };

      writeNext();
      return;
    }

    if (pathname === '/api/up' && method === 'POST') {
      let receivedBytes = 0;
      let exceeded = false;
      let responded = false;

      const handleTooLarge = () => {
        if (responded) return;
        responded = true;
        exceeded = true;
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
        if (!responded && !res.writableEnded) {
          responded = true;
          res.destroy();
        }
      });
      return;
    }

    if (pathname === '/api/meta' && method === 'GET') {
      const clientIp = resolveClientIp(req);
      sendJson(res, 200, { ispName, serverLabel, clientIp }, commonHeaders);
      return;
    }

    if (pathname === '/api/looking-glass/presets' && method === 'GET') {
      sendJson(res, 200, { ok: true, presets: LOOKING_GLASS_PRESETS }, commonHeaders);
      return;
    }

    if (pathname === '/api/looking-glass' && method === 'POST') {
      const clientIp = resolveClientIp(req);
      const rateState = lookingGlassLimiter.check(clientIp);
      if (!rateState.allowed) {
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
          if (!res.writableEnded) {
            sendJson(res, 200, { ok: true, ...probeResult }, commonHeaders);
          }
        })
        .catch((err) => {
          if (res.writableEnded) return;
          if (err instanceof LookingGlassError) {
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
