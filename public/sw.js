const CACHE_NAME = 'testai-static-v1';
const CACHE_PREFIX = 'testai-static-';

const APP_SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest'];

/**
 * Determina se uma requisição deve ignorar completamente o Service Worker.
 * Regra crítica: nunca interceptar medições, endpoints dinâmicos, /config.json,
 * /api/*, speed.cloudflare.com ou métodos diferentes de GET.
 *
 * @param {Request} request
 * @param {string} currentOrigin
 * @returns {boolean}
 */
function shouldBypassRequest(request, currentOrigin) {
  if (!request || request.method !== 'GET') {
    return true;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(request.url, currentOrigin);
  } catch {
    return true;
  }

  // Nunca interceptar domínios externos (incluindo speed.cloudflare.com)
  if (parsedUrl.origin !== currentOrigin) {
    return true;
  }

  const { pathname } = parsedUrl;

  // Nunca interceptar API de medição, config dinâmica ou o próprio Service Worker
  if (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/config.json' ||
    pathname === '/sw.js'
  ) {
    return true;
  }

  // Interceptar apenas navegação e assets estáticos do App Shell
  const isNavigation =
    request.mode === 'navigate' || pathname === '/' || pathname === '/index.html';
  const isStaticAsset =
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/icons/') ||
    pathname === '/manifest.webmanifest';

  return !(isNavigation || isStaticAsset);
}

/**
 * Estratégia Network-First com atualização silenciosa de cache e fallback offline.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    if (
      response &&
      response.ok &&
      (!response.type || response.type === 'basic') &&
      typeof response.clone === 'function'
    ) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }

    if (request.mode === 'navigate') {
      const fallback = (await cache.match('/index.html')) || (await cache.match('/'));
      if (fallback) {
        return fallback;
      }
    }

    throw err;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.allSettled(APP_SHELL_URLS.map((url) => cache.add(url))))
      .finally(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const origin = self.location?.origin || '';
  if (shouldBypassRequest(event.request, origin)) {
    return;
  }

  event.respondWith(networkFirst(event.request));
});
