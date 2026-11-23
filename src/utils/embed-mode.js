/**
 * Utilitários de modo Widget (`?embed=1`) e cópia segura para a área de transferência
 * com fallback compatível com contexto restrito de `iframe`.
 */

/**
 * Detecta se a página foi aberta em modo Widget (`?embed=1` ou `?embed=true`).
 *
 * @param {string} [search]
 * @returns {boolean}
 */
export function isEmbedMode(search = '') {
  if (typeof search !== 'string' || !search.trim()) {
    return false;
  }

  try {
    const params = new URLSearchParams(search);
    const val = (params.get('embed') || '').trim().toLowerCase();
    return val === '1' || val === 'true';
  } catch {
    return false;
  }
}

/**
 * Aplica ou remove a classe `is-embed` no `<body>` conforme a query string atual.
 *
 * @param {string} [search]
 * @param {Document | null} [doc]
 * @returns {boolean}
 */
export function applyEmbedMode(
  search = typeof globalThis.location?.search === 'string' ? globalThis.location.search : '',
  doc = typeof globalThis.document !== 'undefined' ? globalThis.document : null
) {
  const active = isEmbedMode(search);
  if (doc?.body?.classList && typeof doc.body.classList.toggle === 'function') {
    doc.body.classList.toggle('is-embed', active);
  }
  return active;
}

/**
 * Copia texto puro utilizando Clipboard API com fallback via `<textarea>` + `execCommand('copy')`
 * para suportar `iframe` ou navegadores sem permissão direta de Clipboard API.
 *
 * @param {string} text
 * @param {{ nav?: any, doc?: any }} [deps]
 * @returns {Promise<boolean>}
 */
export async function copyTextToClipboard(
  text,
  {
    nav = typeof globalThis.navigator !== 'undefined' ? globalThis.navigator : null,
    doc = typeof globalThis.document !== 'undefined' ? globalThis.document : null
  } = {}
) {
  const value = String(text ?? '');
  if (!value) {
    return false;
  }

  if (nav?.clipboard && typeof nav.clipboard.writeText === 'function') {
    try {
      await nav.clipboard.writeText(value);
      return true;
    } catch {
      // Prossegue para o fallback de textarea em ambientes restritos / iframe
    }
  }

  if (!doc || typeof doc.createElement !== 'function' || !doc.body) {
    return false;
  }

  const textarea = doc.createElement('textarea');
  textarea.value = value;
  if (typeof textarea.setAttribute === 'function') {
    textarea.setAttribute('readonly', '');
  }
  if (textarea.style) {
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
  }

  try {
    doc.body.appendChild(textarea);
    textarea.focus?.();
    textarea.select?.();
    if (typeof doc.execCommand === 'function') {
      return Boolean(doc.execCommand('copy'));
    }
    return false;
  } catch {
    return false;
  } finally {
    if (typeof textarea.remove === 'function') {
      textarea.remove();
    } else if (typeof doc.body.removeChild === 'function') {
      try {
        doc.body.removeChild(textarea);
      } catch {
        // noop
      }
    }
  }
}
