/**
 * Helper seguro de ícones SVG inline (estilo geométrico Lucide 24x24).
 * Constrói SVG exclusivamente via DOM API (createElementNS), sem URLs externas nem marcação HTML bruta.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @typedef {{
 *   tag: 'path' | 'polygon' | 'circle' | 'rect' | 'line' | 'polyline',
 *   attrs: Record<string, string>
 * }} SvgNodeSpec
 */

/** @type {Readonly<Record<string, readonly SvgNodeSpec[]>>} */
export const SVG_ICON_REGISTRY = Object.freeze({
  play: Object.freeze([
    Object.freeze({ tag: 'polygon', attrs: { points: '6 3 20 12 6 21 6 3' } })
  ]),
  refresh: Object.freeze([
    Object.freeze({
      tag: 'path',
      attrs: { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }
    }),
    Object.freeze({ tag: 'path', attrs: { d: 'M21 3v5h-5' } }),
    Object.freeze({
      tag: 'path',
      attrs: { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }
    }),
    Object.freeze({ tag: 'path', attrs: { d: 'M8 16H3v5' } })
  ]),
  stop: Object.freeze([
    Object.freeze({ tag: 'rect', attrs: { x: '6', y: '6', width: '12', height: '12', rx: '2' } })
  ]),
  share: Object.freeze([
    Object.freeze({ tag: 'circle', attrs: { cx: '18', cy: '5', r: '3' } }),
    Object.freeze({ tag: 'circle', attrs: { cx: '6', cy: '12', r: '3' } }),
    Object.freeze({ tag: 'circle', attrs: { cx: '18', cy: '19', r: '3' } }),
    Object.freeze({ tag: 'line', attrs: { x1: '8.59', y1: '13.51', x2: '15.42', y2: '17.49' } }),
    Object.freeze({ tag: 'line', attrs: { x1: '15.41', y1: '6.51', x2: '8.59', y2: '10.49' } })
  ]),
  copy: Object.freeze([
    Object.freeze({
      tag: 'rect',
      attrs: { x: '9', y: '9', width: '13', height: '13', rx: '2', ry: '2' }
    }),
    Object.freeze({
      tag: 'path',
      attrs: { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }
    })
  ]),
  check: Object.freeze([
    Object.freeze({ tag: 'polyline', attrs: { points: '20 6 9 17 4 12' } })
  ]),
  gamepad: Object.freeze([
    Object.freeze({ tag: 'line', attrs: { x1: '6', y1: '11', x2: '10', y2: '11' } }),
    Object.freeze({ tag: 'line', attrs: { x1: '8', y1: '9', x2: '8', y2: '13' } }),
    Object.freeze({ tag: 'line', attrs: { x1: '15', y1: '12', x2: '15.01', y2: '12' } }),
    Object.freeze({ tag: 'line', attrs: { x1: '18', y1: '10', x2: '18.01', y2: '10' } }),
    Object.freeze({
      tag: 'path',
      attrs: {
        d: 'M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z'
      }
    })
  ]),
  video: Object.freeze([
    Object.freeze({
      tag: 'path',
      attrs: { d: 'm16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5' }
    }),
    Object.freeze({
      tag: 'rect',
      attrs: { x: '2', y: '6', width: '14', height: '12', rx: '2' }
    })
  ]),
  tv: Object.freeze([
    Object.freeze({
      tag: 'rect',
      attrs: { x: '2', y: '3', width: '20', height: '14', rx: '2' }
    }),
    Object.freeze({ tag: 'line', attrs: { x1: '8', y1: '21', x2: '16', y2: '21' } }),
    Object.freeze({ tag: 'line', attrs: { x1: '12', y1: '17', x2: '12', y2: '21' } }),
    Object.freeze({ tag: 'polygon', attrs: { points: '10 8 15 10 10 12 10 8' } })
  ])
});

/**
 * Retorna a definição geométrica do ícone solicitado ou null se desconhecido.
 * @param {string} name
 */
export function getIconSpec(name) {
  if (typeof name !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(SVG_ICON_REGISTRY, name)
    ? SVG_ICON_REGISTRY[name]
    : null;
}

/**
 * Cria elemento `<svg>` seguro via createElementNS (estilo 24x24 stroke currentColor).
 * @param {string} name
 * @param {{ size?: number, className?: string }} [options]
 * @returns {SVGSVGElement | null}
 */
export function createSvgIcon(name, options = {}) {
  const spec = getIconSpec(name);
  if (!spec || typeof document === 'undefined' || typeof document.createElementNS !== 'function') {
    return null;
  }

  const size = Number.isFinite(options.size) && Number(options.size) > 0 ? Number(options.size) : 18;
  const svg = /** @type {SVGSVGElement} */ (document.createElementNS(SVG_NS, 'svg'));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', options.className ? `ui-icon ${options.className}` : 'ui-icon');

  for (const nodeSpec of spec) {
    const el = document.createElementNS(SVG_NS, nodeSpec.tag);
    for (const [k, v] of Object.entries(nodeSpec.attrs)) {
      el.setAttribute(k, v);
    }
    svg.appendChild(el);
  }

  return svg;
}

/**
 * Atualiza um botão com ícone SVG inline e rótulo textual usando exclusivamente DOM API segura.
 * Faz fallback seguro para `textContent` em ambientes de mock sem createElementNS.
 *
 * @param {HTMLElement | null} button
 * @param {string} iconName
 * @param {string} label
 */
export function setButtonIconAndLabel(button, iconName, label) {
  if (!button) return;

  const canBuildDom =
    typeof document !== 'undefined' &&
    typeof document.createElement === 'function' &&
    typeof document.createElementNS === 'function' &&
    typeof button.appendChild === 'function' &&
    typeof button.removeChild === 'function';

  if (!canBuildDom) {
    button.textContent = label;
    return;
  }

  while (button.firstChild) {
    button.removeChild(button.firstChild);
  }

  const svg = createSvgIcon(iconName, { size: 18 });
  if (svg) {
    button.appendChild(svg);
  }

  const span = document.createElement('span');
  span.className = 'btn-label';
  span.textContent = label;
  button.appendChild(span);
}
