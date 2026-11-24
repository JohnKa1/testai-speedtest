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
    pathname === '/download' ||
    pathname === '/upload' ||
    pathname === '/ping' ||
    pathname === '/metrics' ||
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
 * Detecta se a aplicação já está sendo executada instalada em modo standalone.
 *
 * @param {any} [win]
 * @param {any} [nav]
 * @returns {boolean}
 */
export function isStandaloneDisplayMode(
  win = globalThis.window,
  nav = globalThis.navigator,
) {
  try {
    if (win && typeof win.matchMedia === 'function') {
      if (win.matchMedia('(display-mode: standalone)')?.matches === true) {
        return true;
      }
    }
  } catch {
    // matchMedia pode estar indisponível em ambientes restritos
  }
  return nav?.standalone === true;
}

/**
 * Retorna instrução curta de instalação manual quando o navegador não dispara
 * `beforeinstallprompt` (ex.: Safari/iOS, Firefox ou cooldown do Chrome).
 *
 * @param {string | null | undefined} [userAgent]
 * @returns {string}
 */
export function getManualInstallInstructions(userAgent = globalThis.navigator?.userAgent || '') {
  const ua = String(userAgent || '');
  if (/iphone|ipad|ipod/i.test(ua)) {
    return 'Para instalar no iOS: toque em Compartilhar e depois em "Adicionar à Tela de Início".';
  }
  return 'Para instalar: use o ícone de instalação na barra de endereço ou o menu do navegador → "Instalar aplicativo".';
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
    return await swContainer.register(swUrl, { updateViaCache: 'none' });
  } catch {
    return null;
  }
}

/**
 * Conecta o fluxo de instalação PWA (`beforeinstallprompt`, `appinstalled` e fallback seguro)
 * ao botão no cabeçalho sem manipular HTML diretamente.
 *
 * @param {object} [options]
 * @param {any} [options.win]
 * @param {any} [options.doc]
 * @param {any} [options.nav]
 * @param {string} [options.buttonId]
 * @param {(message: string) => void} [options.onFallback]
 * @returns {{ triggerInstall: () => Promise<boolean>, cleanup: () => void }}
 */
export function setupInstallPrompt({
  win = globalThis.window,
  doc = globalThis.document,
  nav = globalThis.navigator,
  buttonId = 'installAppBtn',
  onFallback,
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
    if (!installBtn) return;
    const labelEl =
      typeof installBtn.querySelector === 'function'
        ? installBtn.querySelector('.btn-label')
        : null;
    if (labelEl) {
      labelEl.textContent = 'Instalar App';
    } else if (!installBtn.firstChild) {
      installBtn.textContent = 'Instalar App';
    }
    if (installBtn.classList && typeof installBtn.classList.remove === 'function') {
      installBtn.classList.remove('hidden');
    }
  };

  const isEmbed = Boolean(doc?.body?.classList?.contains?.('is-embed'));
  if (isStandaloneDisplayMode(win, nav) || isEmbed) {
    hideButton();
  } else {
    showButton();
  }

  const triggerInstall = async () => {
    if (!deferredPrompt || typeof deferredPrompt.prompt !== 'function') {
      if (typeof onFallback === 'function') {
        onFallback(getManualInstallInstructions(nav?.userAgent));
      }
      return false;
    }

    const promptEvent = deferredPrompt;
    deferredPrompt = null;

    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') {
        hideButton();
        return true;
      }
      return false;
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
    if (!isStandaloneDisplayMode(win, nav) && !doc?.body?.classList?.contains?.('is-embed')) {
      showButton();
    }
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
