/**
 * Carregador e validador de configuração white-label em tempo de execução (`public/config.json`).
 * Fornece fallback automático e imutável para os endpoints da Cloudflare quando
 * o arquivo não existir, retornar erro HTTP ou vier malformado.
 */

export const RUNTIME_ROUTES = Object.freeze({
  ON_NET: 'on-net',
  OFF_NET_FALLBACK: 'off-net-fallback'
});

export const DEFAULT_CONFIG_TIMEOUT_MS = 2500;

export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  ispName: 'TestAi',
  serverLabel: 'Cloudflare Edge',
  measurementMode: 'commercial',
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
  return Math.max(1, Math.min(8, intVal));
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

function isCloudflareEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.trim()) return true;
  return /speed\.cloudflare\.com/i.test(endpoint.trim());
}

/**
 * Determina se a configuração aponta para infraestrutura própria On-Net do provedor
 * ou para o fallback externo Off-Net (Cloudflare Edge).
 *
 * @param {any} config
 * @param {{ usedFallback?: boolean }} [options]
 * @returns {'on-net' | 'off-net-fallback'}
 */
export function resolveRuntimeRoute(config, { usedFallback = false } = {}) {
  if (usedFallback) {
    return RUNTIME_ROUTES.OFF_NET_FALLBACK;
  }
  const endpoints = config?.endpoints;
  if (!endpoints || typeof endpoints !== 'object') {
    return RUNTIME_ROUTES.OFF_NET_FALLBACK;
  }

  const candidates = [endpoints.down, endpoints.up, endpoints.ping].filter(
    (url) => typeof url === 'string' && url.trim().length > 0
  );
  if (candidates.length === 0) {
    return RUNTIME_ROUTES.OFF_NET_FALLBACK;
  }

  const hasOnNetEndpoint = candidates.some((url) => !isCloudflareEndpoint(url));
  return hasOnNetEndpoint ? RUNTIME_ROUTES.ON_NET : RUNTIME_ROUTES.OFF_NET_FALLBACK;
}

let activeRuntimeConfig = mergeRuntimeConfig(null);
/**
 * @type {{
 *   ready: boolean,
 *   loading: boolean,
 *   activeRoute: 'on-net' | 'off-net-fallback',
 *   usedFallback: boolean,
 *   config: ReturnType<typeof mergeRuntimeConfig>
 * }}
 */
let activeRuntimeState = {
  ready: false,
  loading: false,
  activeRoute: RUNTIME_ROUTES.OFF_NET_FALLBACK,
  usedFallback: true,
  config: activeRuntimeConfig
};

export function getRuntimeConfig() {
  return activeRuntimeConfig;
}

export function getRuntimeState() {
  return {
    ...activeRuntimeState,
    config: activeRuntimeConfig
  };
}

/**
 * @param {any} config
 * @param {{ usedFallback?: boolean }} [options]
 */
export function setRuntimeConfig(config, { usedFallback = false } = {}) {
  const isNullFallback = config === null || config === undefined;
  const fallbackFlag = Boolean(usedFallback || isNullFallback);
  activeRuntimeConfig = mergeRuntimeConfig(config);
  activeRuntimeState = {
    ready: true,
    loading: false,
    activeRoute: resolveRuntimeRoute(activeRuntimeConfig, { usedFallback: fallbackFlag }),
    usedFallback: fallbackFlag,
    config: activeRuntimeConfig
  };
  return activeRuntimeConfig;
}

/**
 * Carrega `./config.json` em tempo de execução (`cache: 'no-store'`) com timeout curto,
 * validando e aplicando fallback seguro para `DEFAULT_RUNTIME_CONFIG` em qualquer falha.
 *
 * @param {{ url?: string, fetchImpl?: typeof globalThis.fetch, timeoutMs?: number }} [options]
 */
export async function loadRuntimeConfig({
  url = './config.json',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_CONFIG_TIMEOUT_MS
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return setRuntimeConfig(null, { usedFallback: true });
  }

  const safeTimeoutMs =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.floor(Number(timeoutMs))
      : DEFAULT_CONFIG_TIMEOUT_MS;

  activeRuntimeState = {
    ...activeRuntimeState,
    loading: true
  };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timeoutId = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort('config-timeout');
      } catch {
        // noop
      }
      reject(new Error('RUNTIME_CONFIG_TIMEOUT'));
    }, safeTimeoutMs);
  });

  try {
    const fetchOpts = controller
      ? { cache: /** @type {RequestCache} */ ('no-store'), signal: controller.signal }
      : { cache: /** @type {RequestCache} */ ('no-store') };

    const json = await Promise.race([
      (async () => {
        const res = await fetchImpl(url, fetchOpts);
        if (!res || !res.ok) {
          throw new Error(`HTTP_${res?.status ?? 0}`);
        }
        return res.json();
      })(),
      timeoutPromise
    ]);

    return setRuntimeConfig(json, { usedFallback: false });
  } catch {
    return setRuntimeConfig(null, { usedFallback: true });
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}
