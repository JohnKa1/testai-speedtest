/**
 * Serviço cliente de comunicação com o backend Looking Glass (`/api/looking-glass`).
 * Detecta automaticamente se o servidor self-hosted está disponível e aplica
 * fallback elegante sem erros em deploys estáticos (ex.: Vercel).
 */

import { getRuntimeConfig } from './runtime-config.js';

/**
 * Resolve a URL base da API Looking Glass a partir da configuração em tempo de execução.
 *
 * @param {any} [runtimeConfig]
 * @returns {string}
 */
export function resolveLookingGlassApiBase(runtimeConfig = getRuntimeConfig()) {
  if (typeof runtimeConfig?.apiBaseUrl === 'string' && runtimeConfig.apiBaseUrl.trim()) {
    return runtimeConfig.apiBaseUrl.trim().replace(/\/+$/, '');
  }

  const metaUrl = runtimeConfig?.endpoints?.meta;
  if (typeof metaUrl === 'string' && /^https?:\/\//i.test(metaUrl.trim())) {
    try {
      return new URL(metaUrl.trim()).origin;
    } catch {
      return '';
    }
  }

  return '';
}

function isHtmlResponse(res) {
  const ct = res?.headers?.get?.('content-type') || '';
  return ct.toLowerCase().includes('text/html');
}

/**
 * Consulta os presets disponíveis de Looking Glass. Em deploys estáticos (404/HTML)
 * ou erro de rede, retorna `{ available: false, presets: [] }` silenciosamente.
 *
 * @param {any} [runtimeConfig]
 * @param {{ fetchImpl?: typeof globalThis.fetch }} [deps]
 * @returns {Promise<{ available: boolean, presets: Array<{ id: string, label: string, host: string, port: number }> }>}
 */
export async function fetchLookingGlassPresets(
  runtimeConfig = getRuntimeConfig(),
  { fetchImpl = globalThis.fetch } = {}
) {
  if (typeof fetchImpl !== 'function') {
    return { available: false, presets: [] };
  }

  const base = resolveLookingGlassApiBase(runtimeConfig);
  const url = `${base}/api/looking-glass/presets`;

  try {
    const res = await fetchImpl(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    if (!res || !res.ok || isHtmlResponse(res)) {
      return { available: false, presets: [] };
    }
    const data = await res.json();
    if (!data || data.ok !== true || !Array.isArray(data.presets)) {
      return { available: false, presets: [] };
    }
    return { available: true, presets: data.presets };
  } catch {
    return { available: false, presets: [] };
  }
}

/**
 * Executa uma sonda TCP Looking Glass via `POST /api/looking-glass` e normaliza
 * respostas 200, 429 (rate limit), 400/403 (Anti-SSRF) e 404/rede (indisponível).
 *
 * @param {{ presetId?: string, host?: string, port?: number }} payload
 * @param {any} [runtimeConfig]
 * @param {{ fetchImpl?: typeof globalThis.fetch }} [deps]
 * @returns {Promise<{
 *   ok: boolean,
 *   status?: number,
 *   code?: string,
 *   retryAfterSec?: number,
 *   error?: string,
 *   result?: {
 *     target: string,
 *     resolvedIp: string,
 *     port: number,
 *     samplesMs: number[],
 *     minMs: number | null,
 *     avgMs: number | null,
 *     maxMs: number | null,
 *     jitterMs: number | null,
 *     packetLossPct: number
 *   }
 * }>}
 */
export async function runLookingGlassProbe(
  payload,
  runtimeConfig = getRuntimeConfig(),
  { fetchImpl = globalThis.fetch } = {}
) {
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      status: 0,
      code: 'UNAVAILABLE',
      error: 'O diagnóstico de rota (Looking Glass) requer o servidor self-hosted (Docker/Node.js) ativo.'
    };
  }

  const base = resolveLookingGlassApiBase(runtimeConfig);
  const url = `${base}/api/looking-glass`;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload || {})
    });
  } catch {
    return {
      ok: false,
      status: 0,
      code: 'UNAVAILABLE',
      error: 'Não foi possível contactar o servidor Looking Glass. Recurso disponível na hospedagem self-hosted.'
    };
  }

  if (!res || res.status === 404 || isHtmlResponse(res)) {
    return {
      ok: false,
      status: res?.status || 404,
      code: 'UNAVAILABLE',
      error: 'O diagnóstico de rota (Looking Glass) requer o servidor self-hosted (Docker/Node.js) ativo.'
    };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (res.status === 429) {
    const headerRetry = Number(res.headers?.get?.('retry-after'));
    const bodyRetry = Number(data?.retryAfterSec);
    const retryAfterSec =
      Number.isFinite(headerRetry) && headerRetry > 0
        ? Math.ceil(headerRetry)
        : Number.isFinite(bodyRetry) && bodyRetry > 0
          ? Math.ceil(bodyRetry)
          : 60;
    return {
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSec,
      error:
        data?.error ||
        `Limite de consultas Looking Glass atingido. Tente novamente em ${retryAfterSec}s.`
    };
  }

  if (res.status === 400 || res.status === 403) {
    return {
      ok: false,
      status: res.status,
      code: data?.code || (res.status === 403 ? 'SSRF_BLOCKED' : 'INVALID_TARGET'),
      error:
        data?.error ||
        (res.status === 403
          ? 'Destino bloqueado pela política de segurança Anti-SSRF.'
          : 'Host ou porta inválidos. Informe um domínio/IP público nas portas 443 ou 80.')
    };
  }

  if (res.ok && data?.ok) {
    return {
      ok: true,
      status: res.status,
      result: {
        target: data.target,
        resolvedIp: data.resolvedIp,
        port: data.port,
        samplesMs: Array.isArray(data.samplesMs) ? data.samplesMs : [],
        minMs: data.minMs ?? null,
        avgMs: data.avgMs ?? null,
        maxMs: data.maxMs ?? null,
        jitterMs: data.jitterMs ?? null,
        packetLossPct: data.packetLossPct ?? 100
      }
    };
  }

  return {
    ok: false,
    status: res.status || 500,
    code: data?.code || 'SERVER_ERROR',
    error: data?.error || 'Falha ao executar sonda de rota Looking Glass.'
  };
}
