import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import './helpers.js';

describe('TestAi — Integridade de UI, Contratos DOM e Tokens CSS', () => {
  it('inclui gauge SVG, estados iniciais .is-empty, rótulos de média/pico e tooltips [data-tip] em index.html', () => {
    const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="simpleGaugeSvg"'));
    assert.ok(html.includes('id="simpleGaugeArc"'));
    assert.ok(html.includes('simple-stat is-empty'));
    assert.ok(html.includes('metric-card is-empty'));
    assert.ok(html.includes('avg-box is-empty'));
    assert.ok(html.includes('canvas-wrap is-empty'));
    assert.ok(html.includes('tabindex="0"'));
    assert.ok(html.includes('data-tip='));
    assert.ok(html.includes('PICO OBSERVADO'));
    assert.ok(html.includes('Upload (P90)'));
    assert.ok(html.includes('id="routeOriginBadge"'));
    assert.ok(html.includes('class="empty-state-text"'));
  });

  it('mantém arquitetura CSS modular sem literais de cor fora de tokens.css, sem fonte < 13px e com --brand restrito', () => {
    const manifest = fs.readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8');
    const expectedImports = [
      'tokens.css',
      'base.css',
      'controls.css',
      'simple-mode.css',
      'device-panel.css',
      'advanced-mode.css',
      'states-tooltips.css',
      'responsive.css'
    ];

    for (const file of expectedImports) {
      assert.ok(manifest.includes(`./${file}`), `main.css deve importar ./${file}`);
    }

    const stylesDirUrl = new URL('../src/styles/', import.meta.url);
    const statesCss = fs.readFileSync(new URL('states-tooltips.css', stylesDirUrl), 'utf8');
    const motionMarker = '@media (prefers-reduced-motion: no-preference)';
    const motionIdx = statesCss.indexOf(motionMarker);
    assert.ok(motionIdx >= 0, 'states-tooltips.css deve proteger shimmer com prefers-reduced-motion');
    const beforeMotionCss = statesCss.slice(0, motionIdx);
    const insideMotionCss = statesCss.slice(motionIdx);
    assert.equal(
      beforeMotionCss.includes('skeletonShimmer'),
      false,
      'shimmer do esqueleto não deve aparecer fora de @media (prefers-reduced-motion: no-preference)'
    );
    assert.ok(
      insideMotionCss.includes('.simple-stat.is-empty .simple-stat-value'),
      'states-tooltips.css deve incluir shimmer dos placeholders dentro de prefers-reduced-motion: no-preference'
    );

    const smallFontRegex =
      /font-size:\s*(?:0?\.[0-7]\d*rem|0?\.8(?:0\d*|1[0-1]\d*|12[0-4]?)?rem|(?:[0-9]|1[0-2])(?:\.\d+)?px)/;
    const brandAllowedFiles = new Set(['tokens.css', 'base.css', 'controls.css']);

    for (const file of expectedImports) {
      const css = fs.readFileSync(new URL(file, stylesDirUrl), 'utf8');
      assert.equal(smallFontRegex.test(css), false, `${file} não deve conter font-size < 13px`);

      if (file !== 'tokens.css') {
        assert.equal(
          /#[0-9a-fA-F]{3,8}|rgba?\(/.test(css),
          false,
          `${file} não deve conter hexadecimais ou rgba() fora de tokens.css`
        );
      }

      if (!brandAllowedFiles.has(file)) {
        assert.equal(/--brand\b/.test(css), false, `${file} não deve usar --brand`);
      }
    }

    const chartsJs = fs.readFileSync(new URL('../src/components/charts.js', import.meta.url), 'utf8');
    assert.equal(
      /#22d3ee|#00d4ff|#00e5ff/i.test(chartsJs),
      false,
      'charts.js não deve conter ciano hardcoded'
    );
  });

  it('registra o clique em #startBtnSimple imediatamente mesmo quando document.readyState já é complete', async () => {
    const mainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    assert.ok(mainSource.includes("document.readyState === 'loading'"));

    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    const prevGetComputedStyle = globalThis.getComputedStyle;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevCancelRaf = globalThis.cancelAnimationFrame;

    const listeners = new Map();
    const elements = new Map();
    const makeMockEl = (id = '') => ({
      id,
      textContent: '',
      value: '',
      disabled: false,
      style: { setProperty() {}, width: '', height: '' },
      dataset: {},
      parentElement: null,
      firstChild: null,
      classList: {
        _s: new Set(),
        add(...items) {
          items.forEach((x) => this._s.add(x));
        },
        remove(...items) {
          items.forEach((x) => this._s.delete(x));
        },
        toggle(x, force) {
          if (force === undefined) {
            if (this._s.has(x)) this._s.delete(x);
            else this._s.add(x);
          } else if (force) {
            this._s.add(x);
          } else {
            this._s.delete(x);
          }
        },
        contains(x) {
          return this._s.has(x);
        }
      },
      setAttribute() {},
      addEventListener(ev, fn) {
        listeners.set(`${id}:${ev}`, fn);
      },
      closest() {
        return null;
      },
      appendChild() {},
      removeChild() {},
      getBoundingClientRect() {
        return { width: 400, height: 180 };
      },
      getContext() {
        return {
          setTransform() {},
          clearRect() {},
          fillText() {},
          measureText: () => ({ width: 40 }),
          beginPath() {},
          moveTo() {},
          lineTo() {},
          stroke() {},
          fillRect() {},
          arc() {},
          fill() {},
          closePath() {},
          save() {},
          restore() {}
        };
      }
    });

    try {
      globalThis.window = {
        ...prevWindow,
        addEventListener() {},
        setInterval: () => 1,
        clearInterval() {},
        devicePixelRatio: 1
      };
      globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
      globalThis.requestAnimationFrame = () => 1;
      globalThis.cancelAnimationFrame = () => {};
      globalThis.document = {
        readyState: 'complete',
        documentElement: makeMockEl('html'),
        body: makeMockEl('body'),
        addEventListener(ev, fn) {
          listeners.set(`doc:${ev}`, fn);
        },
        getElementById(id) {
          if (!elements.has(id)) elements.set(id, makeMockEl(id));
          return elements.get(id);
        },
        querySelectorAll() {
          return [];
        },
        createElement(tag) {
          return makeMockEl(tag);
        },
        createTextNode(t) {
          return { t };
        }
      };

      await import(`../src/main.js?readyStateTest=${Date.now()}`);
      assert.equal(
        typeof listeners.get('startBtnSimple:click'),
        'function',
        'Botão Iniciar Teste deve ter listener registrado imediatamente quando readyState === complete'
      );
      assert.equal(
        typeof listeners.get('startBtnAdv:click'),
        'function',
        'Botão Iniciar Diagnóstico deve ter listener registrado imediatamente'
      );
    } finally {
      globalThis.window = prevWindow;
      globalThis.document = prevDocument;
      globalThis.getComputedStyle = prevGetComputedStyle;
      globalThis.requestAnimationFrame = prevRaf;
      globalThis.cancelAnimationFrame = prevCancelRaf;
    }
  });

  it('pausa animação de .bg-layer durante a medição (body.is-measuring) e quando a aba fica oculta (body.is-page-hidden)', async () => {
    const baseCss = fs.readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
    const mainJs = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

    // 1. Verifica regras CSS de pausa em src/styles/base.css dentro de prefers-reduced-motion: no-preference
    assert.ok(
      baseCss.includes('body.is-measuring .bg-layer') &&
        baseCss.includes('body.is-page-hidden .bg-layer') &&
        baseCss.includes('animation-play-state: paused;'),
      'base.css deve pausar .bg-layer quando body tiver .is-measuring ou .is-page-hidden'
    );

    // 2. Verifica sincronização de is-page-hidden com document.hidden em src/main.js
    assert.ok(
      mainJs.includes("classList?.toggle('is-page-hidden', Boolean(document.hidden))"),
      'main.js deve sincronizar body.is-page-hidden com document.hidden'
    );

    // 3. Verifica que setRunningControls(true/false) adiciona e remove is-measuring em document.body
    const prevDocument = globalThis.document;
    const bodyClasses = new Set();

    try {
      globalThis.document = {
        body: {
          classList: {
            toggle(cls, force) {
              if (force) bodyClasses.add(cls);
              else bodyClasses.delete(cls);
            },
            contains(cls) {
              return bodyClasses.has(cls);
            }
          }
        },
        getElementById: () => null
      };

      const { setRunningControls } = await import(
        `../src/ui/telemetry-view.js?measuringTest=${Date.now()}`
      );

      setRunningControls(true);
      assert.equal(
        globalThis.document.body.classList.contains('is-measuring'),
        true,
        'setRunningControls(true) deve adicionar is-measuring ao document.body'
      );

      setRunningControls(false);
      assert.equal(
        globalThis.document.body.classList.contains('is-measuring'),
        false,
        'setRunningControls(false) deve remover is-measuring do document.body'
      );
    } finally {
      globalThis.document = prevDocument;
    }
  });
});
