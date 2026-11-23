/**
 * Carregador e validador de configuração white-label em tempo de execução (`public/config.json`).
 * Fornece fallback automático e imutável para os endpoints da Cloudflare quando
 * o arquivo não existir, retornar erro HTTP ou vier malformado.
 */

export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  ispName: 'TestAi',
  serverLabel: 'Cloudflare Edge',
  measurementMode: 'sustained',
  parallelStreams: Object.freeze({
    download: 6,
    upload: 4
  }),
  endpoints: Object.freeze({
    down: 'https://speed.cloudflare.com/__down',
    up: 'https://speed.cloudflare.com/__up',
    ping: 'https://speed.cloudflare.com/__down',
    meta: null
  })
});

function readNonEmptyString(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function readStreamCount(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  const intVal = Math.floor(num);
  return Math.max(1, Math.min(16, intVal));
}

/**
 * Mescla uma configuração bruta com o objeto padrão garantindo tipos válidos.
 *
 * @param {any} raw
 */
export function mergeRuntimeConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawStreams =
    src.parallelStreams && typeof src.parallelStreams === 'object' && !Array.isArray(src.parallelStreams)
      ? src.parallelStreams
      : {};
  const rawEndpoints =
    src.endpoints && typeof src.endpoints === 'object' && !Array.isArray(src.endpoints)
      ? src.endpoints
      : {};

  const modeCandidate = typeof src.measurementMode === 'string' ? src.measurementMode.trim() : '';
  const measurementMode =
    modeCandidate === 'sustained' || modeCandidate === 'commercial'
      ? modeCandidate
      : DEFAULT_RUNTIME_CONFIG.measurementMode;

  const metaCandidate =
    typeof rawEndpoints.meta === 'string' && rawEndpoints.meta.trim().length > 0
      ? rawEndpoints.meta.trim()
      : null;

  return {
    ispName: readNonEmptyString(src.ispName, DEFAULT_RUNTIME_CONFIG.ispName),
    serverLabel: readNonEmptyString(src.serverLabel, DEFAULT_RUNTIME_CONFIG.serverLabel),
    measurementMode,
    parallelStreams: {
      download: readStreamCount(rawStreams.download, DEFAULT_RUNTIME_CONFIG.parallelStreams.download),
      upload: readStreamCount(rawStreams.upload, DEFAULT_RUNTIME_CONFIG.parallelStreams.upload)
    },
    endpoints: {
      down: readNonEmptyString(rawEndpoints.down, DEFAULT_RUNTIME_CONFIG.endpoints.down),
      up: readNonEmptyString(rawEndpoints.up, DEFAULT_RUNTIME_CONFIG.endpoints.up),
      ping: readNonEmptyString(rawEndpoints.ping, DEFAULT_RUNTIME_CONFIG.endpoints.ping),
      meta: metaCandidate
    }
  };
}

let activeRuntimeConfig = mergeRuntimeConfig(null);

export function getRuntimeConfig() {
  return activeRuntimeConfig;
}

/**
 * @param {any} config
 */
export function setRuntimeConfig(config) {
  activeRuntimeConfig = mergeRuntimeConfig(config);
  return activeRuntimeConfig;
}

/**
 * Carrega `./config.json` em tempo de execução (`cache: 'no-store'`), validando e
 * aplicando fallback seguro para `DEFAULT_RUNTIME_CONFIG` em qualquer falha.
 *
 * @param {{ url?: string, fetchImpl?: typeof globalThis.fetch }} [options]
 */
export async function loadRuntimeConfig({
  url = './config.json',
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return mergeRuntimeConfig(null);
  }

  try {
    const res = await fetchImpl(url, { cache: 'no-store' });
    if (!res || !res.ok) {
      return mergeRuntimeConfig(null);
    }
    const json = await res.json();
    return mergeRuntimeConfig(json);
  } catch {
    return mergeRuntimeConfig(null);
  }
}
