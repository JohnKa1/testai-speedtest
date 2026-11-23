import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { evaluateConnection } from '../src/diagnostics/connection-diagnostics.js';
import { buildShareSummaryText } from '../src/services/share-card.js';
import { evaluateUsageProfiles } from '../src/services/usage-verdict.js';
import { createSvgIcon, SVG_ICON_REGISTRY } from '../src/ui/icons.js';
import { renderUsageVerdictsAndComparison } from '../src/ui/insights-view.js';
import { humanizeSimpleVerdictSummary } from '../src/ui/simple-view.js';
import {
  formatContractedPlanReference,
  formatGaugeScaleMaxLabel,
  PHASE_LABELS,
  renderTabularSpeedValue,
  resolveGaugeScaleMax,
  setRunningControls,
  splitTabularSpeed,
  updateSimpleGaugePlanMarker
} from '../src/ui/telemetry-view.js';
import { METRIC_STATUS } from '../src/utils/validators.js';

const ROOT_DIR = process.cwd();

function readUtf8(...segments) {
  return fs.readFileSync(path.join(ROOT_DIR, ...segments), 'utf8');
}

function createDomNode(tag, id = '', namespace = null) {
  const attrs = new Map();
  const classSet = new Set();
  const node = {
    tagName: tag,
    namespaceURI: namespace,
    id,
    disabled: false,
    _text: '',
    children: [],
    style: { width: '', setProperty() {} },
    dataset: {},
    get firstChild() {
      return this.children[0] || null;
    },
    get textContent() {
      if (this.children.length > 0) {
        return this.children.map((c) => c.textContent).join('');
      }
      return this._text;
    },
    set textContent(val) {
      this._text = String(val ?? '');
      this.children = [];
    },
    get className() {
      return [...classSet].join(' ');
    },
    set className(val) {
      classSet.clear();
      String(val || '')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classSet.add(c));
    },
    classList: {
      add: (...items) => items.forEach((c) => classSet.add(c)),
      remove: (...items) => items.forEach((c) => classSet.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classSet.has(c)) classSet.delete(c);
          else classSet.add(c);
        } else if (force) {
          classSet.add(c);
        } else {
          classSet.delete(c);
        }
      },
      contains: (c) => classSet.has(c)
    },
    setAttribute(k, v) {
      attrs.set(k, String(v));
    },
    getAttribute(k) {
      return attrs.has(k) ? attrs.get(k) : null;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
      return child;
    }
  };
  return node;
}

test('rótulos pós-teste: botão exibe "Testar novamente" e status "Teste concluído" sem "DOWNLOAD Concluído"', () => {
  assert.equal(PHASE_LABELS.completed, 'Teste concluído');

  const prevDocument = globalThis.document;
  const startBtnSimple = createDomNode('button', 'startBtnSimple');
  const startBtnAdv = createDomNode('button', 'startBtnAdv');
  const byId = new Map([
    ['startBtnSimple', startBtnSimple],
    ['startBtnAdv', startBtnAdv]
  ]);

  try {
    globalThis.document = {
      body: createDomNode('body'),
      getElementById: (id) => byId.get(id) || null,
      createElement: (tag) => createDomNode(tag),
      createElementNS: (ns, tag) => createDomNode(tag, '', ns)
    };

    setRunningControls(false, { hasCompleted: false });
    assert.equal(startBtnSimple.textContent, 'Iniciar Teste');

    setRunningControls(true, { hasCompleted: true });
    assert.equal(startBtnSimple.textContent, 'Cancelar Teste');

    setRunningControls(false, { hasCompleted: true });
    assert.equal(startBtnSimple.textContent, 'Testar novamente');
    assert.ok(startBtnSimple.children.some((c) => c.tagName === 'svg'));
  } finally {
    globalThis.document = prevDocument;
  }

  const mainJs = readUtf8('src', 'main.js');
  const telemetryJs = readUtf8('src', 'ui', 'telemetry-view.js');
  assert.equal(mainJs.includes('DOWNLOAD Concluído'), false);
  assert.equal(telemetryJs.includes('DOWNLOAD Concluído'), false);
});

test('veredito humanizado remove notação técnica (Δ) no Modo Simples preservando picos e mantendo Δ no Avançado', () => {
  const cleanMsg = humanizeSimpleVerdictSummary(
    'A conexão entregou 520.0 Mbps de download (P90) e 260.0 Mbps de upload (P90) com baixa latência ociosa (10 ms) e mínima variação sob saturação (Δ +0 ms ↓ / Δ +0 ms ↑).'
  );
  assert.equal(cleanMsg.includes('Δ'), false);
  assert.match(cleanMsg, /sem aumento de latência durante download e upload/);

  const isolatedSpikeMsg = humanizeSimpleVerdictSummary(
    'A conexão entregou 520.0 Mbps de download (P90) e 260.0 Mbps de upload (P90) com baixa latência ociosa (10 ms) e variação mediana controlada sob carga (Δ +0 ms ↓ / Δ +2 ms ↑), com pico isolado de 270 ms durante o upload.'
  );
  assert.equal(isolatedSpikeMsg.includes('Δ'), false);
  assert.match(isolatedSpikeMsg, /pico isolado de 270 ms durante o upload/);

  const recurrentSpikeMsg = humanizeSimpleVerdictSummary(
    'Apesar da mediana sob carga controlada (Δ +0 ms ↓ / Δ +0 ms ↑), 3 de 8 amostras apresentaram picos de até 290 ms durante o download.'
  );
  assert.equal(recurrentSpikeMsg.includes('Δ'), false);
  assert.match(recurrentSpikeMsg, /3 de 8 amostras apresentaram picos de até 290 ms durante o download/);

  // Diagnóstico técnico e resumo compartilhável continuam preservando Δ
  const resultFixture = {
    id: 'run-ux-1',
    timestamp: '2026-11-23T20:00:00Z',
    incomplete: false,
    durationMs: 10000,
    measurementMode: 'commercial',
    profile: { id: 'standard', label: 'Padrão' },
    context: { linkType: 'ethernet', contractedMbps: 400, notes: '' },
    metrics: {
      download: { value: 368.0, status: METRIC_STATUS.MEASURED, unit: 'Mbps' },
      upload: { value: 210.0, status: METRIC_STATUS.MEASURED, unit: 'Mbps' },
      ping: { value: 11, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      jitter: { value: 1.8, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadLatency: { value: 14, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadLatency: { value: 15, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadJitter: { value: 1.9, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadJitter: { value: 2.0, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadLatencyDelta: { value: 3, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadLatencyDelta: { value: 4, status: METRIC_STATUS.MEASURED, unit: 'ms' }
    },
    stats: {
      download: { count: 6, min: 340, p10: 342, p50: 355, mean: 358, p90: 368, p95: 375, max: 380, stdDev: 12, cv: 0.03 },
      upload: { count: 6, min: 190, p10: 192, p50: 200, mean: 202, p90: 210, p95: 215, max: 220, stdDev: 9, cv: 0.04 },
      unloadedLatency: { count: 8, min: 10, p10: 10, p50: 11, mean: 11, p90: 12, p95: 13, max: 13, stdDev: 1, cv: 0.08 }
    },
    series: {
      downloadPoints: [{ bps: 355e6, mbps: 355, elapsedMs: 1200 }, { bps: 368e6, mbps: 368, elapsedMs: 2000 }],
      uploadPoints: [{ bps: 200e6, mbps: 200, elapsedMs: 1200 }, { bps: 210e6, mbps: 210, elapsedMs: 2000 }],
      unloadedLatencyPoints: [{ index: 0, ms: 11 }],
      downloadLatencyPoints: [{ index: 0, ms: 14 }],
      uploadLatencyPoints: [{ index: 0, ms: 15 }]
    }
  };
  const advDiag = evaluateConnection(resultFixture);
  assert.ok(advDiag.summary.includes('Δ'));
  const shareText = buildShareSummaryText(resultFixture, { measurementMode: 'commercial' });
  assert.ok(shareText.includes('Latência sob carga: Δ'));
});

test('escala dinâmica, referência % do plano contratado, marcador SVG e ocultação em embed', () => {
  assert.equal(formatContractedPlanReference(368, 400), '92% do plano contratado (400 Mbps)');
  assert.equal(formatContractedPlanReference(368, 0), null);
  assert.equal(formatContractedPlanReference(null, 400), null);

  assert.equal(resolveGaugeScaleMax(null), 1200);
  assert.equal(resolveGaugeScaleMax(500), 1200);
  assert.equal(resolveGaugeScaleMax(2000), 2500);
  assert.equal(formatGaugeScaleMaxLabel(1200), '1,2 Gbps');
  assert.equal(formatGaugeScaleMaxLabel(2500), '2,5 Gbps');

  const prevDocument = globalThis.document;
  const maxLabelEl = createDomNode('span', 'simpleGaugeMaxLabel');
  const markerEl = createDomNode('circle', 'simpleGaugeTargetMarker', 'http://www.w3.org/2000/svg');
  markerEl.classList.add('hidden');
  const byId = new Map([
    ['simpleGaugeMaxLabel', maxLabelEl],
    ['simpleGaugeTargetMarker', markerEl]
  ]);

  try {
    globalThis.document = {
      getElementById: (id) => byId.get(id) || null
    };

    updateSimpleGaugePlanMarker(400);
    assert.equal(maxLabelEl.textContent, '1,2 Gbps');
    assert.equal(markerEl.classList.contains('hidden'), false);
    assert.ok(Number(markerEl.getAttribute('cx')) > 24);
    assert.ok(Number(markerEl.getAttribute('cy')) >= 22);

    updateSimpleGaugePlanMarker(null);
    assert.equal(markerEl.classList.contains('hidden'), true);
  } finally {
    globalThis.document = prevDocument;
  }

  const html = readUtf8('index.html');
  const mainJs = readUtf8('src', 'main.js');
  const simpleCss = readUtf8('src', 'styles', 'simple-mode.css');
  assert.ok(html.includes('id="simpleContractedInput"'));
  assert.ok(html.includes('id="simplePlanRef"'));
  assert.ok(html.includes('id="simpleGaugeTargetMarker"'));
  assert.ok(html.includes('id="simpleGaugeMaxLabel"'));
  assert.ok(mainJs.includes('syncContractedPlanValue'));
  assert.ok(simpleCss.includes('body.is-embed .simple-plan-bar'));
});

test('tipografia tabular no placar principal e separação inteiro/decimal', () => {
  const simpleCss = readUtf8('src', 'styles', 'simple-mode.css');
  assert.match(simpleCss, /\.simple-speed-number\s*\{[^}]*font-family:\s*var\(--font\);/s);
  assert.match(simpleCss, /\.simple-speed-number\s*\{[^}]*font-variant-numeric:\s*tabular-nums;/s);
  assert.equal(
    /\.simple-speed-number\s*\{[^}]*var\(--mono\)/s.test(simpleCss),
    false,
    '.simple-speed-number não deve usar var(--mono)'
  );
  assert.match(simpleCss, /\.simple-speed-number\s+\.speed-dec\s*\{/);

  assert.deepEqual(splitTabularSpeed('354.3'), {
    isNumeric: true,
    intPart: '354',
    decPart: ',3',
    text: '354,3'
  });
  assert.deepEqual(splitTabularSpeed('—'), {
    isNumeric: false,
    intPart: '—',
    decPart: '',
    text: '—'
  });

  const prevDocument = globalThis.document;
  const speedEl = createDomNode('span', 'simpleCurrentSpeed');
  try {
    globalThis.document = {
      getElementById: (id) => (id === 'simpleCurrentSpeed' ? speedEl : null),
      createElement: (tag) => createDomNode(tag)
    };
    renderTabularSpeedValue('simpleCurrentSpeed', '354.3');
    assert.equal(speedEl.children.length, 2);
    assert.equal(speedEl.children[0].className, 'speed-int');
    assert.equal(speedEl.children[0].textContent, '354');
    assert.equal(speedEl.children[1].className, 'speed-dec');
    assert.equal(speedEl.children[1].textContent, ',3');
    assert.equal(speedEl.textContent, '354,3');
  } finally {
    globalThis.document = prevDocument;
  }
});

test('ícones SVG inline via createElementNS (zero externo/innerHTML) e barras de folga distintas nos selos de uso', () => {
  for (const name of ['play', 'refresh', 'stop', 'share', 'copy', 'check', 'gamepad', 'video', 'tv']) {
    assert.ok(Array.isArray(SVG_ICON_REGISTRY[name]) && SVG_ICON_REGISTRY[name].length > 0);
  }

  const prevDocument = globalThis.document;
  const section = createDomNode('section', 'usageVerdictSection');
  const grid = createDomNode('div', 'usageVerdictGrid');
  const deltaBar = createDomNode('div', 'comparisonDeltaBar');
  const byId = new Map([
    ['usageVerdictSection', section],
    ['usageVerdictGrid', grid],
    ['comparisonDeltaBar', deltaBar]
  ]);

  try {
    globalThis.document = {
      getElementById: (id) => byId.get(id) || null,
      createElement: (tag) => createDomNode(tag),
      createElementNS: (ns, tag) => createDomNode(tag, '', ns)
    };

    const svg = createSvgIcon('gamepad', { size: 18 });
    assert.ok(svg);
    assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    assert.equal(svg.getAttribute('stroke'), 'currentColor');

    const verdicts = evaluateUsageProfiles({
      incomplete: false,
      metrics: {
        download: { value: 420, status: METRIC_STATUS.MEASURED },
        upload: { value: 180, status: METRIC_STATUS.MEASURED },
        ping: { value: 12, status: METRIC_STATUS.MEASURED },
        jitter: { value: 2.0, status: METRIC_STATUS.MEASURED },
        downloadLatencyDelta: { value: 4, status: METRIC_STATUS.MEASURED },
        uploadLatencyDelta: { value: 6, status: METRIC_STATUS.MEASURED }
      },
      stats: { download: { p50: 380, mean: 390 } }
    });

    assert.deepEqual(
      verdicts.map((v) => v.icon),
      ['gamepad', 'video', 'tv']
    );
    for (const v of verdicts) {
      assert.equal(typeof v.headroomPct, 'number');
      assert.ok(v.headroomLabel && v.headroomLabel.length > 0);
    }

    renderUsageVerdictsAndComparison(verdicts, null);
    assert.equal(grid.children.length, 3);
    for (const card of grid.children) {
      const topRow = card.children[0];
      const titleWrap = topRow.children[0];
      assert.equal(titleWrap.children[0].tagName, 'svg');
      const marginWrap = card.children[2];
      assert.equal(marginWrap.className, 'usage-margin-wrap');
      const track = marginWrap.children[0];
      const fill = track.children[0];
      assert.match(fill.style.width, /^\d+%$/);
    }
  } finally {
    globalThis.document = prevDocument;
  }

  const iconsJs = readUtf8('src', 'ui', 'icons.js');
  const iconsWithoutSvgNs = iconsJs.replace('http://www.w3.org/2000/svg', '');
  assert.equal(/https?:\/\//.test(iconsWithoutSvgNs), false);
  assert.equal(/fetch\(|<use\b/.test(iconsJs), false);
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(iconsJs), false);

  const simpleCss = readUtf8('src', 'styles', 'simple-mode.css');
  assert.equal(/#[0-9a-fA-F]{3,8}|rgba?\(/.test(simpleCss), false);
});
