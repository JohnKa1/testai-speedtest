import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import {
  isPwaSecureContext,
  registerServiceWorker,
  setupInstallPrompt,
  shouldBypassPwaCache,
} from '../src/services/pwa.js';

const ROOT_DIR = process.cwd();
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('manifest.webmanifest é válido e referencia ícones existentes', () => {
  const manifestPath = path.join(ROOT_DIR, 'public', 'manifest.webmanifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.name, 'TestAi — Medidor de Velocidade');
  assert.equal(manifest.short_name, 'TestAi');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.background_color, /^#[0-9a-fA-F]{6}$/);
  assert.match(manifest.theme_color, /^#[0-9a-fA-F]{6}$/);
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);

  const expectedIcons = [
    { src: '/icons/icon-192.png', sizes: '192x192', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', purpose: 'any' },
    { src: '/icons/icon-maskable-512.png', sizes: '512x512', purpose: 'maskable' },
  ];

  for (const expected of expectedIcons) {
    const match = manifest.icons.find(
      (icon) => icon.src === expected.src && icon.purpose === expected.purpose,
    );
    assert.ok(match, `Ícone ${expected.src} (${expected.purpose}) ausente no manifesto`);
    assert.equal(match.sizes, expected.sizes);
    assert.equal(match.type, 'image/png');

    const diskPath = path.join(ROOT_DIR, 'public', expected.src.replace(/^\//, ''));
    const buf = fs.readFileSync(diskPath);
    assert.deepEqual(buf.subarray(0, 8), PNG_SIGNATURE, `${expected.src} não é PNG válido`);

    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const [expW, expH] = expected.sizes.split('x').map(Number);
    assert.equal(width, expW);
    assert.equal(height, expH);
  }
});

test('index.html referencia manifesto, theme-color, apple-touch-icon e botão instalar no cabeçalho', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
  assert.match(html, /<meta\s+name="theme-color"\s+content="#0B0F19"\s*\/?>/);
  assert.match(html, /<link\s+rel="manifest"\s+href="\.\/manifest\.webmanifest"\s*\/?>/);
  assert.match(
    html,
    /<link\s+rel="apple-touch-icon"[^>]+href="\.\/icons\/icon-192\.png"[^>]*\/?>/,
  );
  assert.match(html, /id="installAppBtn"/);
  assert.match(html, /class="[^"]*\bpill\b[^"]*\bpill-action-btn\b[^"]*"\s+id="installAppBtn"/);
});

test('shouldBypassPwaCache ignora medições, API, config.json e POST', () => {
  const origin = 'https://speed.isp.com.br';

  // Bypass obrigatório
  assert.equal(
    shouldBypassPwaCache('https://speed.cloudflare.com/__down?bytes=1000000', origin),
    true,
  );
  assert.equal(
    shouldBypassPwaCache(
      { url: 'https://speed.cloudflare.com/__up', method: 'POST' },
      origin,
    ),
    true,
  );
  assert.equal(shouldBypassPwaCache(`${origin}/api/down?bytes=1000000`, origin), true);
  assert.equal(
    shouldBypassPwaCache({ url: `${origin}/api/up`, method: 'POST' }, origin),
    true,
  );
  assert.equal(shouldBypassPwaCache(`${origin}/api/ping`, origin), true);
  assert.equal(shouldBypassPwaCache(`${origin}/api/meta`, origin), true);
  assert.equal(shouldBypassPwaCache(`${origin}/config.json`, origin), true);
  assert.equal(shouldBypassPwaCache(`${origin}/sw.js`, origin), true);
  assert.equal(
    shouldBypassPwaCache({ url: `${origin}/`, method: 'POST' }, origin),
    true,
  );

  // Navegação e assets estáticos devem usar Network-First
  assert.equal(
    shouldBypassPwaCache({ url: `${origin}/`, method: 'GET', mode: 'navigate' }, origin),
    false,
  );
  assert.equal(shouldBypassPwaCache(`${origin}/index.html`, origin), false);
  assert.equal(shouldBypassPwaCache(`${origin}/assets/index-123.js`, origin), false);
  assert.equal(shouldBypassPwaCache(`${origin}/icons/icon-192.png`, origin), false);
  assert.equal(shouldBypassPwaCache(`${origin}/manifest.webmanifest`, origin), false);
});

function createMockServiceWorkerEnv(origin = 'https://speed.isp.com.br') {
  const listeners = new Map();
  const cacheStores = new Map();
  let fetchHandler = async () => ({
    ok: true,
    type: 'basic',
    status: 200,
    body: 'network-ok',
    clone() {
      return { ...this };
    },
  });

  function getStore(name) {
    if (!cacheStores.has(name)) {
      cacheStores.set(name, new Map());
    }
    return cacheStores.get(name);
  }

  const cachesMock = {
    async open(name) {
      const store = getStore(name);
      return {
        async add(url) {
          store.set(url, { ok: true, type: 'basic', status: 200, body: `pre:${url}` });
        },
        async put(req, res) {
          const key = typeof req === 'string' ? req : req.url;
          store.set(key, res);
        },
        async match(req) {
          const key = typeof req === 'string' ? req : req.url;
          if (store.has(key)) return store.get(key);
          const pathname = new URL(key, origin).pathname;
          return store.get(pathname) || undefined;
        },
      };
    },
    async keys() {
      return Array.from(cacheStores.keys());
    },
    async delete(name) {
      return cacheStores.delete(name);
    },
  };

  const selfMock = {
    location: { origin },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    async skipWaiting() {},
    clients: { async claim() {} },
  };

  const sandbox = {
    self: selfMock,
    caches: cachesMock,
    URL,
    Promise,
    fetch: (...args) => fetchHandler(...args),
  };

  const swCode = fs.readFileSync(path.join(ROOT_DIR, 'public', 'sw.js'), 'utf8');
  vm.runInNewContext(swCode, sandbox, { filename: 'public/sw.js' });

  return {
    listeners,
    cacheStores,
    setFetchImpl(fn) {
      fetchHandler = fn;
    },
  };
}

test('public/sw.js faz bypass estrito em endpoints de medição e aplica Network-First nos estáticos', async () => {
  const origin = 'https://speed.isp.com.br';
  const env = createMockServiceWorkerEnv(origin);

  // Simula cache antigo pré-existente e verifica limpeza no activate
  env.cacheStores.set('testai-static-v0', new Map([['/old.js', {}]]));
  let activatePromise;
  env.listeners.get('activate')({
    waitUntil(p) {
      activatePromise = p;
    },
  });
  await activatePromise;
  assert.equal(env.cacheStores.has('testai-static-v0'), false);

  const dispatchFetch = (request) => {
    let respondedWith = null;
    env.listeners.get('fetch')({
      request,
      respondWith(promise) {
        respondedWith = promise;
      },
    });
    return respondedWith;
  };

  // Nunca chama respondWith em medição, config.json, cross-origin ou POST
  const bypassedRequests = [
    { url: 'https://speed.cloudflare.com/__down?bytes=1024', method: 'GET' },
    { url: 'https://speed.cloudflare.com/__up', method: 'POST' },
    { url: `${origin}/api/down?bytes=1024`, method: 'GET' },
    { url: `${origin}/api/up`, method: 'POST' },
    { url: `${origin}/api/ping`, method: 'GET' },
    { url: `${origin}/config.json`, method: 'GET' },
    { url: `${origin}/sw.js`, method: 'GET' },
    { url: `${origin}/assets/app.js`, method: 'POST' },
  ];

  for (const req of bypassedRequests) {
    const resPromise = dispatchFetch(req);
    assert.equal(
      resPromise,
      null,
      `SW não deveria interceptar ${req.method} ${req.url}`,
    );
  }

  // Network-First para página e assets estáticos, com fallback offline após cache
  let networkCalls = 0;
  env.setFetchImpl(async () => {
    networkCalls += 1;
    return {
      ok: true,
      type: 'basic',
      status: 200,
      body: 'fresh-bundle',
      clone() {
        return { ok: true, type: 'basic', status: 200, body: 'cached-bundle' };
      },
    };
  });

  const assetReq = { url: `${origin}/assets/index-abc.js`, method: 'GET', mode: 'cors' };
  const onlinePromise = dispatchFetch(assetReq);
  assert.ok(onlinePromise, 'SW deve responder GET em /assets/*');
  const onlineRes = await onlinePromise;
  assert.equal(onlineRes.body, 'fresh-bundle');
  assert.equal(networkCalls, 1);

  // Quando a rede cai, devolve do cache armazenado anteriormente
  env.setFetchImpl(async () => {
    throw new Error('offline');
  });
  const offlineRes = await dispatchFetch(assetReq);
  assert.equal(offlineRes.body, 'cached-bundle');
});

test('isPwaSecureContext e registerServiceWorker respeitam HTTPS e localhost', async () => {
  assert.equal(isPwaSecureContext({ protocol: 'https:', hostname: 'isp.net.br' }, true), true);
  assert.equal(isPwaSecureContext({ protocol: 'http:', hostname: 'localhost' }, true), true);
  assert.equal(isPwaSecureContext({ protocol: 'http:', hostname: '127.0.0.1' }, true), true);
  assert.equal(isPwaSecureContext({ protocol: 'http:', hostname: '192.168.1.10' }, false), false);

  let calledWith = null;
  const navigatorMock = {
    serviceWorker: {
      async register(url) {
        calledWith = url;
        return { scope: '/' };
      },
    },
  };

  // HTTP remoto inseguro não registra SW
  const skipped = await registerServiceWorker({
    navigatorObj: navigatorMock,
    locationObj: { protocol: 'http:', hostname: '192.168.0.1' },
    isSecureContextFlag: false,
  });
  assert.equal(skipped, null);
  assert.equal(calledWith, null);

  // HTTPS registra ./sw.js
  const registered = await registerServiceWorker({
    navigatorObj: navigatorMock,
    locationObj: { protocol: 'https:', hostname: 'speed.isp.com.br' },
    isSecureContextFlag: true,
  });
  assert.deepEqual(registered, { scope: '/' });
  assert.equal(calledWith, './sw.js');

  // Erro no registro não quebra inicialização
  const failed = await registerServiceWorker({
    navigatorObj: {
      serviceWorker: {
        async register() {
          throw new Error('blocked');
        },
      },
    },
    locationObj: { protocol: 'https:', hostname: 'speed.isp.com.br' },
    isSecureContextFlag: true,
  });
  assert.equal(failed, null);
});

test('setupInstallPrompt exibe botão fora do standalone, usa fallback seguro e oculta após instalar', async () => {
  const winListeners = new Map();
  const btnListeners = new Map();
  const classes = new Set(['pill', 'pill-action-btn']);
  let fallbackMessage = '';

  const installBtn = {
    textContent: 'Instalar App',
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
    },
    addEventListener(type, fn) { btnListeners.set(type, fn); },
    removeEventListener(type) { btnListeners.delete(type); },
  };

  const winMock = {
    matchMedia() { return { matches: false }; },
    addEventListener(type, fn) { winListeners.set(type, fn); },
    removeEventListener(type) { winListeners.delete(type); },
  };

  const docMock = {
    getElementById(id) { return id === 'installAppBtn' ? installBtn : null; },
  };

  const controller = setupInstallPrompt({
    win: winMock,
    doc: docMock,
    nav: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' },
    onFallback: (msg) => { fallbackMessage = msg; },
  });
  assert.equal(classes.has('hidden'), false);

  const beforePromptResult = await controller.triggerInstall();
  assert.equal(beforePromptResult, false);
  assert.match(fallbackMessage, /Compartilhar/i);

  let prevented = false;
  let prompted = false;
  winListeners.get('beforeinstallprompt')({
    preventDefault() { prevented = true; },
    async prompt() { prompted = true; },
    userChoice: Promise.resolve({ outcome: 'accepted' }),
  });

  assert.equal(prevented, true);
  assert.equal(classes.has('hidden'), false);
  assert.equal(installBtn.textContent, 'Instalar App');

  const accepted = await controller.triggerInstall();
  assert.equal(prompted, true);
  assert.equal(accepted, true);
  assert.equal(classes.has('hidden'), true);

  classes.delete('hidden');
  winListeners.get('appinstalled')();
  assert.equal(classes.has('hidden'), true);

  controller.cleanup();
  assert.equal(winListeners.size, 0);

  classes.delete('hidden');
  const standaloneCtrl = setupInstallPrompt({
    win: { ...winMock, matchMedia() { return { matches: true }; } },
    doc: docMock,
  });
  assert.equal(classes.has('hidden'), true);
  standaloneCtrl.cleanup();
});
