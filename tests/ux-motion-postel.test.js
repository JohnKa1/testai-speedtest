import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DeviceSpecsService,
  expandTolerantDeviceQuery,
} from '../src/services/device-specs.service.js';
import {
  resetTelemetryUI,
  setActiveMetricPhase,
  setRunningControls,
} from '../src/ui/telemetry-view.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STYLES_DIR = path.join(ROOT_DIR, 'src', 'styles');

/**
 * Extrai o conteúdo interno do bloco `@media (prefers-reduced-motion: no-preference) { ... }`.
 *
 * @param {string} cssText
 * @returns {string}
 */
function extractReducedMotionNoPrefBlock(cssText) {
  const marker = '@media (prefers-reduced-motion: no-preference)';
  const idx = cssText.indexOf(marker);
  if (idx === -1) return '';
  const openBrace = cssText.indexOf('{', idx);
  if (openBrace === -1) return '';

  let depth = 0;
  for (let i = openBrace; i < cssText.length; i++) {
    const ch = cssText[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return cssText.slice(openBrace + 1, i);
      }
    }
  }
  return '';
}

/**
 * Cria um mock mínimo de elemento DOM para validar mudanças de classe/atributo sem JSDOM.
 *
 * @param {{ id?: string, classes?: string[] }} [opts]
 */
function makeMockElement(opts = {}) {
  const classSet = new Set(opts.classes || []);
  /** @type {Map<string, string>} */
  const attrs = new Map();
  /** @type {any} */
  let parentCard = null;

  return {
    id: opts.id || '',
    disabled: false,
    textContent: '',
    value: '',
    style: { width: '' },
    _setClosestCard(/** @type {any} */ card) {
      parentCard = card;
    },
    classList: {
      add: (/** @type {string} */ c) => classSet.add(c),
      remove: (/** @type {string} */ c) => classSet.delete(c),
      toggle: (/** @type {string} */ c, /** @type {boolean} */ force) => {
        if (force === undefined) {
          if (classSet.has(c)) {
            classSet.delete(c);
            return false;
          }
          classSet.add(c);
          return true;
        }
        if (force) classSet.add(c);
        else classSet.delete(c);
        return Boolean(force);
      },
      contains: (/** @type {string} */ c) => classSet.has(c),
    },
    setAttribute: (/** @type {string} */ name, /** @type {string} */ val) => {
      attrs.set(name, String(val));
    },
    getAttribute: (/** @type {string} */ name) => (attrs.has(name) ? attrs.get(name) ?? null : null),
    removeAttribute: (/** @type {string} */ name) => {
      attrs.delete(name);
    },
    closest: (/** @type {string} */ selector) => {
      if (parentCard && selector.includes('.simple-stat') && parentCard.classList.contains('simple-stat')) {
        return parentCard;
      }
      if (parentCard && selector.includes('.metric-card') && parentCard.classList.contains('metric-card')) {
        return parentCard;
      }
      return null;
    },
  };
}

test('CSS NOC Motion: define --ease-noc, hits confortáveis >= 46px e respeita prefers-reduced-motion', () => {
  const tokensCss = fs.readFileSync(path.join(STYLES_DIR, 'tokens.css'), 'utf8');
  const baseCss = fs.readFileSync(path.join(STYLES_DIR, 'base.css'), 'utf8');
  const controlsCss = fs.readFileSync(path.join(STYLES_DIR, 'controls.css'), 'utf8');
  const simpleCss = fs.readFileSync(path.join(STYLES_DIR, 'simple-mode.css'), 'utf8');
  const advancedCss = fs.readFileSync(path.join(STYLES_DIR, 'advanced-mode.css'), 'utf8');
  const deviceCss = fs.readFileSync(path.join(STYLES_DIR, 'device-panel.css'), 'utf8');
  const statesCss = fs.readFileSync(path.join(STYLES_DIR, 'states-tooltips.css'), 'utf8');
  const responsiveCss = fs.readFileSync(path.join(STYLES_DIR, 'responsive.css'), 'utf8');

  // 1. Slow in & slow out + Snappy timing
  assert.match(tokensCss, /--ease-noc:\s*cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\)/);
  assert.match(tokensCss, /--dur-fast:\s*150ms/);
  assert.match(tokensCss, /--dur-snappy:\s*220ms/);
  assert.match(tokensCss, /--ok-pulse-ring:\s*rgba\(/);
  assert.match(tokensCss, /--progress-sheen:\s*rgba\(/);

  for (const [name, css] of [
    ['base.css', baseCss],
    ['controls.css', controlsCss],
    ['simple-mode.css', simpleCss],
    ['advanced-mode.css', advancedCss],
    ['device-panel.css', deviceCss],
    ['states-tooltips.css', statesCss],
  ]) {
    assert.ok(css.includes('var(--ease-noc)'), `${name} deve utilizar var(--ease-noc)`);
  }

  // 2. Secondary action apenas dentro de prefers-reduced-motion: no-preference
  const noPrefBlock = extractReducedMotionNoPrefBlock(statesCss);
  assert.ok(noPrefBlock.length > 0, 'states-tooltips.css deve conter @media (prefers-reduced-motion: no-preference)');
  assert.match(noPrefBlock, /@keyframes onlineDotPulse/);
  assert.match(noPrefBlock, /\.status-dot\.online/);
  assert.match(noPrefBlock, /@keyframes progressSheen/);
  assert.match(noPrefBlock, /\.progress-wrap\.is-running\s+\.progress-bar::after/);

  const outsideNoPref = statesCss.replace(noPrefBlock, '');
  assert.equal(
    outsideNoPref.includes('onlineDotPulse'),
    false,
    'onlineDotPulse não deve existir fora de prefers-reduced-motion: no-preference'
  );
  assert.equal(
    outsideNoPref.includes('progressSheen'),
    false,
    'progressSheen não deve existir fora de prefers-reduced-motion: no-preference'
  );

  // 3. Fitts's law & Bigger hit areas
  assert.match(controlsCss, /\.btn-secondary\s*\{[^}]*min-height:\s*46px/s);
  assert.match(controlsCss, /\.btn-secondary\s*\{[^}]*touch-action:\s*manipulation/s);
  assert.match(controlsCss, /\.btn-primary\s*\{[^}]*touch-action:\s*manipulation/s);
  assert.match(deviceCss, /\.chip-btn\s*\{[^}]*min-height:\s*46px/s);
  assert.match(deviceCss, /\.chip-btn\s*\{[^}]*touch-action:\s*manipulation/s);
  assert.match(baseCss, /\.mode-btn\s*\{[^}]*touch-action:\s*manipulation/s);
  assert.match(simpleCss, /\.simple-verdict-card\s+\.btn-secondary\s*\{[^}]*width:\s*100%/s);
  assert.match(responsiveCss, /\.simple-verdict-card\s+\.btn-secondary\s*\{[^}]*width:\s*auto/s);

  // 4. Sobriedade NOC: sem inclinações 3D em cards
  for (const css of [simpleCss, advancedCss, deviceCss]) {
    assert.equal(/rotateX\(|rotateY\(|perspective\(/.test(css), false);
  }
});

test('Staging the focus + Doherty threshold: destaca card da fase ativa e reage no instante inicial', () => {
  const prevDocument = globalThis.document;

  const simplePingCard = makeMockElement({ classes: ['simple-stat'] });
  const simpleDownloadCard = makeMockElement({ classes: ['simple-stat'] });
  const simpleUploadCard = makeMockElement({ classes: ['simple-stat'] });
  const advPingCard = makeMockElement({ classes: ['metric-card'] });
  const advDownloadLatCard = makeMockElement({ classes: ['metric-card'] });
  const advUploadCard = makeMockElement({ classes: ['metric-card'] });

  const allCards = [
    simplePingCard,
    simpleDownloadCard,
    simpleUploadCard,
    advPingCard,
    advDownloadLatCard,
    advUploadCard,
  ];

  const simplePingVal = makeMockElement({ id: 'simplePingVal' });
  simplePingVal._setClosestCard(simplePingCard);
  const simpleDownloadVal = makeMockElement({ id: 'simpleDownloadVal' });
  simpleDownloadVal._setClosestCard(simpleDownloadCard);
  const simpleUploadVal = makeMockElement({ id: 'simpleUploadVal' });
  simpleUploadVal._setClosestCard(simpleUploadCard);

  const pingValue = makeMockElement({ id: 'pingValue' });
  pingValue._setClosestCard(advPingCard);
  const downloadLatencyValue = makeMockElement({ id: 'downloadLatencyValue' });
  downloadLatencyValue._setClosestCard(advDownloadLatCard);
  const uploadValue = makeMockElement({ id: 'uploadValue' });
  uploadValue._setClosestCard(advUploadCard);

  const progressSection = makeMockElement({ id: 'progressSection', classes: ['progress-wrap'] });
  const progressBar = makeMockElement({ id: 'progressBar' });
  const progressLabel = makeMockElement({ id: 'progressLabel' });
  const progressPercent = makeMockElement({ id: 'progressPercent' });

  /** @type {Record<string, any>} */
  const byId = {
    simplePingVal,
    simpleDownloadVal,
    simpleUploadVal,
    pingValue,
    downloadLatencyValue,
    uploadValue,
    progressSection,
    progressBar,
    progressLabel,
    progressPercent,
  };

  try {
    // @ts-ignore Mock DOM mínimo apenas para este teste unitário
    globalThis.document = {
      getElementById: (/** @type {string} */ id) => byId[id] || null,
      querySelector: (/** @type {string} */ sel) => {
        const cleanId = sel.startsWith('#') ? sel.slice(1) : sel;
        return byId[cleanId] || null;
      },
      querySelectorAll: (/** @type {string} */ sel) => {
        if (sel.includes('.is-active-phase')) {
          return allCards.filter((c) => c.classList.contains('is-active-phase'));
        }
        return [];
      },
    };

    // Fase 1: latência
    setActiveMetricPhase('latency');
    assert.equal(simplePingCard.classList.contains('is-active-phase'), true);
    assert.equal(advPingCard.classList.contains('is-active-phase'), true);
    assert.equal(simplePingCard.getAttribute('data-phase-accent'), null);
    assert.equal(simpleDownloadCard.classList.contains('is-active-phase'), false);
    assert.equal(simpleUploadCard.classList.contains('is-active-phase'), false);

    // Fase 2: download migra foco suavemente
    setActiveMetricPhase('download');
    assert.equal(simplePingCard.classList.contains('is-active-phase'), false);
    assert.equal(advPingCard.classList.contains('is-active-phase'), false);
    assert.equal(simpleDownloadCard.classList.contains('is-active-phase'), true);
    assert.equal(advDownloadLatCard.classList.contains('is-active-phase'), true);
    assert.equal(simpleDownloadCard.getAttribute('data-phase-accent'), 'download');
    assert.equal(advDownloadLatCard.getAttribute('data-phase-accent'), 'download');

    // Fase 3: upload migra foco para envio
    setActiveMetricPhase('upload');
    assert.equal(simpleDownloadCard.classList.contains('is-active-phase'), false);
    assert.equal(advDownloadLatCard.classList.contains('is-active-phase'), false);
    assert.equal(simpleUploadCard.classList.contains('is-active-phase'), true);
    assert.equal(advUploadCard.classList.contains('is-active-phase'), true);
    assert.equal(simpleUploadCard.getAttribute('data-phase-accent'), 'upload');

    // Finalização limpa tudo
    setActiveMetricPhase(null);
    for (const card of allCards) {
      assert.equal(card.classList.contains('is-active-phase'), false);
      assert.equal(card.getAttribute('data-phase-accent'), null);
    }

    // Telemetry running feedback (< 400ms Doherty threshold)
    setRunningControls(true);
    assert.equal(progressSection.classList.contains('is-running'), true);

    resetTelemetryUI('Padrão', null);
    assert.equal(progressBar.style.width, '4%');
    assert.equal(simplePingCard.classList.contains('is-active-phase'), true);
    assert.equal(advPingCard.classList.contains('is-active-phase'), true);

    setRunningControls(false);
    assert.equal(progressSection.classList.contains('is-running'), false);
  } finally {
    globalThis.document = prevDocument;
  }
});

test("Postel's law: expandTolerantDeviceQuery aceita entradas coladas, sem marca e minúsculas preservando SKUs", () => {
  assert.equal(expandTolerantDeviceQuery('a10'), 'Galaxy A10');
  assert.equal(expandTolerantDeviceQuery('s25fe'), 'Galaxy S25 FE');
  assert.equal(expandTolerantDeviceQuery('iphone16'), 'iPhone 16');
  assert.equal(expandTolerantDeviceQuery('iphone16promax'), 'iPhone 16 Pro Max');
  assert.equal(expandTolerantDeviceQuery('motog84'), 'Moto G84');
  assert.equal(expandTolerantDeviceQuery('e22'), 'Moto E22');
  assert.equal(expandTolerantDeviceQuery('redminote13pro5g'), 'Redmi Note 13 Pro 5G');

  // Preserva SKUs / códigos técnicos intactos
  assert.equal(expandTolerantDeviceQuery('SM-A065M'), 'SM-A065M');
  assert.equal(expandTolerantDeviceQuery('  sm-a065m  '), 'sm-a065m');
  assert.equal(expandTolerantDeviceQuery('XT2239-10'), 'XT2239-10');

  // Consultas humanas normais permanecem íntegras
  assert.equal(expandTolerantDeviceQuery('S25 galaxy'), 'S25 Galaxy');
  assert.equal(expandTolerantDeviceQuery('moto e22'), 'Moto E22');
  assert.equal(expandTolerantDeviceQuery('positivo twist'), 'positivo twist');
  assert.equal(expandTolerantDeviceQuery('   '), '');
});

test("Postel's law: DeviceSpecsService resolve buscas tolerantes (a10, s25fe, iphone16, e22)", async () => {
  /** @type {string[]} */
  const requestedQueries = [];

  const mockFetch = async (/** @type {string | URL} */ url) => {
    const parsedUrl = new URL(String(url), 'https://testai.local');
    const q = parsedUrl.searchParams.get('q') || '';
    requestedQueries.push(q);
    const [manufacturer] = q.split(' ');

    return /** @type {any} */ ({
      ok: true,
      status: 200,
      async json() {
        return {
          device: {
            manufacturer: manufacturer === 'Galaxy' ? 'Samsung' : manufacturer,
            model: q,
            wifiStandard: 'Wi-Fi 6E',
            wifiGeneration: 6,
            wifiBands: ['2.4 GHz', '5 GHz', '6 GHz'],
            theoreticalMaxLinkMbps: 2400,
            practicalWifiRangeMbps: [450, 950],
            cellularSummary: '5G + 4G LTE',
            source: 'MockAPI',
          },
        };
      },
    });
  };

  const service = new DeviceSpecsService({ fetchImpl: mockFetch });

  const a10 = await service.lookupDevice('a10');
  assert.equal(a10.status, 'found');
  assert.match(a10.device.model, /A10/i);

  const iphone16 = await service.lookupDevice('iphone16');
  assert.equal(iphone16.status, 'found');
  assert.match(iphone16.device.model, /iPhone 16/i);

  const e22 = await service.lookupDevice('e22');
  assert.equal(e22.status, 'found');
  assert.match(e22.device.model, /E22/i);

  const s25fe = await service.lookupDevice('s25fe');
  assert.equal(s25fe.status, 'found');
  assert.match(s25fe.device.model, /S25 FE/i);

  assert.deepEqual(requestedQueries, [
    'Galaxy A10',
    'iPhone 16',
    'Moto E22',
    'Galaxy S25 FE',
  ]);
});
