/**
 * Gerenciamento leve de PWA no TestAi.
 * Garante registro seguro do Service Worker e exibição discreta do botão
 * de instalação, mantendo medições de rede 100% livres de cache/interferência.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Verifica se o ambiente atual é um contexto seguro compatível com Service Worker.
 *
 * @param {{ protocol?: string, hostname?: string } | null | undefined} [locationObj]
 * @param {boolean | undefined} [isSecureContextFlag]
 * @returns {boolean}
 */
export function isPwaSecureContext(
  locationObj = globalThis.location,
  isSecureContextFlag = globalThis.isSecureContext,
) {
  if (isSecureContextFlag === false) {
    return false;
  }

  if (!locationObj || typeof locationObj.protocol !== 'string') {
    return false;
  }

  if (locationObj.protocol === 'https:') {
    return true;
  }

  if (locationObj.protocol === 'http:' && typeof locationObj.hostname === 'string') {
    return LOOPBACK_HOSTS.has(locationObj.hostname.toLowerCase());
  }

  return false;
}

/**
 * Espelho testável da política de bypass do Service Worker (`public/sw.js`).
 * Retorna `true` quando a requisição NÃO pode passar pelo cache do PWA.
 *
 * @param {string | { url?: string, method?: string, mode?: string }} requestOrUrl
 * @param {string} [currentOrigin]
 * @returns {boolean}
 */
export function shouldBypassPwaCache(
  requestOrUrl,
  currentOrigin = globalThis.location?.origin || 'http://localhost',
) {
  const isString = typeof requestOrUrl === 'string';
  const rawUrl = isString ? requestOrUrl : requestOrUrl?.url;
  const method = (isString ? 'GET' : requestOrUrl?.method || 'GET').toUpperCase();
  const mode = isString ? '' : requestOrUrl?.mode || '';

  if (!rawUrl || method !== 'GET') {
    return true;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl, currentOrigin || 'http://localhost');
  } catch {
    return true;
  }

  const host = parsedUrl.hostname.toLowerCase();
  if (host === 'speed.cloudflare.com' || host.endsWith('.speed.cloudflare.com')) {
    return true;
  }

  if (currentOrigin && parsedUrl.origin !== currentOrigin) {
    return true;
  }

  const { pathname } = parsedUrl;
  if (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/config.json' ||
    pathname === '/sw.js'
  ) {
    return true;
  }

  const isNavigation =
    mode === 'navigate' || pathname === '/' || pathname === '/index.html';
  const isStaticAsset =
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/icons/') ||
    pathname === '/manifest.webmanifest';

  return !(isNavigation || isStaticAsset);
}

/**
 * Registra o Service Worker apenas em navegadores compatíveis e contexto seguro.
 * Nunca propaga exceções caso o navegador bloqueie ou falhe ao registrar.
 *
 * @param {object} [options]
 * @param {any} [options.navigatorObj]
 * @param {{ protocol?: string, hostname?: string }} [options.locationObj]
 * @param {boolean | undefined} [options.isSecureContextFlag]
 * @param {string} [options.swUrl]
 * @returns {Promise<any | null>}
 */
export async function registerServiceWorker({
  navigatorObj = globalThis.navigator,
  locationObj = globalThis.location,
  isSecureContextFlag = globalThis.isSecureContext,
  swUrl = './sw.js',
} = {}) {
  if (!isPwaSecureContext(locationObj, isSecureContextFlag)) {
    return null;
  }

  const swContainer = navigatorObj?.serviceWorker;
  if (!swContainer || typeof swContainer.register !== 'function') {
    return null;
  }

  try {
    return await swContainer.register(swUrl);
  } catch {
    return null;
  }
}

/**
 * Conecta o fluxo nativo de instalação (`beforeinstallprompt` / `appinstalled`)
 * a um botão opcional no cabeçalho sem manipular HTML diretamente.
 *
 * @param {object} [options]
 * @param {any} [options.win]
 * @param {any} [options.doc]
 * @param {string} [options.buttonId]
 * @returns {{ triggerInstall: () => Promise<boolean>, cleanup: () => void }}
 */
export function setupInstallPrompt({
  win = globalThis.window,
  doc = globalThis.document,
  buttonId = 'installAppBtn',
} = {}) {
  const installBtn =
    doc && typeof doc.getElementById === 'function' ? doc.getElementById(buttonId) : null;

  /** @type {any} */
  let deferredPrompt = null;

  const hideButton = () => {
    if (installBtn?.classList && typeof installBtn.classList.add === 'function') {
      installBtn.classList.add('hidden');
    }
  };

  const showButton = () => {
    if (installBtn) {
      installBtn.textContent = 'Instalar App';
      if (installBtn.classList && typeof installBtn.classList.remove === 'function') {
        installBtn.classList.remove('hidden');
      }
    }
  };

  const triggerInstall = async () => {
    if (!deferredPrompt || typeof deferredPrompt.prompt !== 'function') {
      return false;
    }

    const promptEvent = deferredPrompt;
    deferredPrompt = null;
    hideButton();

    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      return choice?.outcome === 'accepted';
    } catch {
      return false;
    }
  };

  /** @param {any} event */
  const handleBeforeInstallPrompt = (event) => {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    deferredPrompt = event;
    showButton();
  };

  const handleAppInstalled = () => {
    deferredPrompt = null;
    hideButton();
  };

  const handleButtonClick = () => {
    triggerInstall();
  };

  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    win.addEventListener('appinstalled', handleAppInstalled);
  }

  if (installBtn && typeof installBtn.addEventListener === 'function') {
    installBtn.addEventListener('click', handleButtonClick);
  }

  const cleanup = () => {
    if (win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      win.removeEventListener('appinstalled', handleAppInstalled);
    }
    if (installBtn && typeof installBtn.removeEventListener === 'function') {
      installBtn.removeEventListener('click', handleButtonClick);
    }
  };

  return { triggerInstall, cleanup };
}
