import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { applyEmbedMode, copyTextToClipboard, isEmbedMode } from '../src/utils/embed-mode.js';
import { buildShareSummaryText } from '../src/services/share-card.js';
import { METRIC_STATUS } from '../src/utils/validators.js';

function createSampleResult(measurementMode = 'commercial') {
  return {
    id: 'run-widget-1',
    timestamp: '2026-11-23T18:45:00.000Z',
    incomplete: false,
    measurementMode,
    metrics: {
      download: { value: 640.5, status: METRIC_STATUS.MEASURED, unit: 'Mbps' },
      upload: { value: 320.2, status: METRIC_STATUS.MEASURED, unit: 'Mbps' },
      ping: { value: 9, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      jitter: { value: 1.4, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadLatency: { value: 18, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadLatency: { value: 15, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadJitter: { value: 2.1, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadJitter: { value: 1.9, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadLatencyDelta: { value: 9, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadLatencyDelta: { value: 6, status: METRIC_STATUS.MEASURED, unit: 'ms' }
    },
    stats: {
      download: { count: 6, min: 500, p10: 520, p50: 580, mean: 585, p90: 640.5, p95: 650, max: 660, stdDev: 40, cv: 0.06 },
      upload: { count: 6, min: 280, p10: 290, p50: 300, mean: 305, p90: 320.2, p95: 330, max: 335, stdDev: 15, cv: 0.05 },
      unloadedLatency: null,
      downloadLatency: null,
      uploadLatency: null
    },
    series: {
      downloadPoints: [{ index: 0, bps: 580_000_000, mbps: 580 }],
      uploadPoints: [{ index: 0, bps: 300_000_000, mbps: 300 }],
      unloadedLatencyPoints: [],
      downloadLatencyPoints: [],
      uploadLatencyPoints: []
    }
  };
}

test('isEmbedMode detecta corretamente ?embed=1 e ?embed=true e ignora demais queries', () => {
  assert.equal(isEmbedMode('?embed=1'), true);
  assert.equal(isEmbedMode('?embed=true'), true);
  assert.equal(isEmbedMode('?tema=escuro&embed=1'), true);
  assert.equal(isEmbedMode('?embed=0'), false);
  assert.equal(isEmbedMode('?foo=bar'), false);
  assert.equal(isEmbedMode(''), false);

  const classes = new Set();
  const mockDoc = /** @type {any} */ ({
    body: {
      classList: {
        toggle(name, force) {
          if (force) classes.add(name);
          else classes.delete(name);
        }
      }
    }
  });

  assert.equal(applyEmbedMode('?embed=1', mockDoc), true);
  assert.equal(classes.has('is-embed'), true);

  assert.equal(applyEmbedMode('?embed=0', mockDoc), false);
  assert.equal(classes.has('is-embed'), false);
});

test('buildShareSummaryText inclui Download, Upload, Ping, Jitter, Δ sob carga, Estabilidade e Modo (P90/P50)', () => {
  const commercialTxt = buildShareSummaryText(createSampleResult('commercial'), {
    ispName: 'FibraSul',
    serverLabel: 'BNG Curitiba',
    measurementMode: 'commercial'
  });

  assert.match(commercialTxt, /FibraSul/);
  assert.match(commercialTxt, /BNG Curitiba/);
  assert.match(commercialTxt, /640\.5 Mbps/);
  assert.match(commercialTxt, /320\.2 Mbps/);
  assert.match(commercialTxt, /Ping:\s*9 ms/);
  assert.match(commercialTxt, /Jitter:\s*1\.4 ms/);
  assert.match(commercialTxt, /Δ \+9 ms/);
  assert.match(commercialTxt, /Estabilidade:/);
  assert.match(commercialTxt, /Modo:\s*Comercial \(P90\)/);

  const sustainedTxt = buildShareSummaryText(createSampleResult('sustained'), {
    ispName: 'TestAi',
    serverLabel: 'Cloudflare Edge',
    measurementMode: 'sustained'
  });
  assert.match(sustainedTxt, /Modo:\s*Sustentado \(P50\)/);
});

test('copyTextToClipboard usa Clipboard API e aplica fallback via textarea quando bloqueada em iframe', async () => {
  let copiedViaClipboard = '';
  const okPrimary = await copyTextToClipboard('Resumo TestAi', {
    nav: {
      clipboard: {
        async writeText(txt) {
          copiedViaClipboard = txt;
        }
      }
    },
    doc: null
  });
  assert.equal(okPrimary, true);
  assert.equal(copiedViaClipboard, 'Resumo TestAi');

  // Fallback quando clipboard.writeText rejeita (ex.: iframe sem permissão)
  let execCommandCalled = '';
  let appendedNode = null;
  let removed = false;
  const okFallback = await copyTextToClipboard('Texto via fallback', {
    nav: {
      clipboard: {
        async writeText() {
          throw new Error('Permissions policy blocked');
        }
      }
    },
    doc: {
      body: {
        appendChild(node) {
          appendedNode = node;
        },
        removeChild() {
          removed = true;
        }
      },
      createElement(tag) {
        assert.equal(tag, 'textarea');
        return {
          value: '',
          style: {},
          setAttribute() {},
          focus() {},
          select() {},
          remove() {
            removed = true;
          }
        };
      },
      execCommand(cmd) {
        execCommandCalled = cmd;
        return true;
      }
    }
  });

  assert.equal(okFallback, true);
  assert.equal(execCommandCalled, 'copy');
  assert.equal(appendedNode?.value, 'Texto via fallback');
  assert.equal(removed, true);
});

test('index.html e simple-mode.css mantêm #copySummaryBtn e estilos is-embed', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  assert.ok(html.includes('id="shareResultBtn"'));
  assert.ok(html.includes('id="copySummaryBtn"'));

  const css = fs.readFileSync(path.join(process.cwd(), 'src', 'styles', 'simple-mode.css'), 'utf8');
  assert.ok(css.includes('body.is-embed'));
});
