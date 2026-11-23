import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildShareFilename,
  buildShareSummaryText,
  renderShareCardBlob,
  shareTestResult
} from '../src/services/share-card.js';
import { METRIC_STATUS } from '../src/utils/validators.js';

function createSampleResult(overrides = {}) {
  return {
    id: 'run-test-1',
    timestamp: '2026-11-23T15:30:00.000Z',
    incomplete: false,
    durationMs: 12400,
    measurementMode: 'sustained',
    metrics: {
      download: { value: 620.4, status: METRIC_STATUS.MEASURED, unit: 'Mbps' },
      upload: { value: 310.2, status: METRIC_STATUS.MEASURED, unit: 'Mbps' },
      ping: { value: 11, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      jitter: { value: 1.8, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadLatency: { value: 23, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadLatency: { value: 19, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadJitter: { value: 3.1, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadJitter: { value: 2.5, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadLatencyDelta: { value: 12, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadLatencyDelta: { value: 8, status: METRIC_STATUS.MEASURED, unit: 'ms' }
    },
    stats: {
      download: { count: 10, min: 480, p10: 510, p50: 615, mean: 620.4, p90: 685.7, p95: 700, max: 712.5, stdDev: 50, cv: 0.08 },
      upload: { count: 8, min: 250, p10: 260, p50: 308, mean: 310.2, p90: 342.4, p95: 350, max: 358.9, stdDev: 25, cv: 0.08 },
      unloadedLatency: null,
      downloadLatency: null,
      uploadLatency: null
    },
    series: {
      downloadPoints: [{ index: 0, bps: 620_400_000, mbps: 620.4, bytes: 1000, duration: 1, measTime: 1 }],
      uploadPoints: [{ index: 0, bps: 310_200_000, mbps: 310.2, bytes: 1000, duration: 1, measTime: 1 }],
      unloadedLatencyPoints: [],
      downloadLatencyPoints: [],
      uploadLatencyPoints: []
    },
    ...overrides
  };
}

test('buildShareSummaryText gera texto formatado com branding padrão e customizado', () => {
  const defaultText = buildShareSummaryText(createSampleResult());
  assert.match(defaultText, /TestAi/);
  assert.match(defaultText, /Cloudflare Edge/);
  assert.match(defaultText, /620\.4 Mbps/);
  assert.match(defaultText, /310\.2 Mbps/);
  assert.match(defaultText, /11 ms/);
  assert.match(defaultText, /Δ \+12 ms/);
  assert.match(defaultText, /Estabilidade:/);

  const customResult = createSampleResult({
    measurementMode: 'commercial',
    series: {
      downloadPoints: [
        { index: 0, bps: 500_000_000, mbps: 500 },
        { index: 1, bps: 685_700_000, mbps: 685.7 }
      ],
      uploadPoints: [
        { index: 0, bps: 280_000_000, mbps: 280 },
        { index: 1, bps: 342_400_000, mbps: 342.4 }
      ],
      unloadedLatencyPoints: [],
      downloadLatencyPoints: [],
      uploadLatencyPoints: []
    }
  });

  const ispText = buildShareSummaryText(customResult, {
    ispName: 'FibraNet Telecom',
    serverLabel: 'POP Centro 10G',
    measurementMode: 'commercial'
  });
  assert.match(ispText, /FibraNet Telecom/);
  assert.match(ispText, /POP Centro 10G/);
  assert.match(ispText, /Sustentado:/);
});

test('renderShareCardBlob desenha métricas e branding no Canvas 2D e retorna Blob PNG', async () => {
  const drawnTexts = [];
  const fakeBlob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

  const createCanvas = (w, h) => {
    const ctx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: 'left',
      beginPath() {},
      moveTo() {},
      lineTo() {},
      quadraticCurveTo() {},
      closePath() {},
      fill() {},
      stroke() {},
      fillRect() {},
      fillText(text) {
        drawnTexts.push(String(text));
      },
      createRadialGradient() {
        return { addColorStop() {} };
      }
    };

    return {
      width: w,
      height: h,
      getContext(type) {
        assert.equal(type, '2d');
        return ctx;
      },
      toBlob(cb, mimeType) {
        assert.equal(mimeType, 'image/png');
        cb(fakeBlob);
      }
    };
  };

  const blob = await renderShareCardBlob(
    createSampleResult(),
    { ispName: 'LinkSul Fibra', serverLabel: 'BNG Porto Alegre' },
    { createCanvas }
  );

  assert.equal(blob.type, 'image/png');
  assert.ok(drawnTexts.some((t) => t.includes('LinkSul Fibra')));
  assert.ok(drawnTexts.some((t) => t.includes('BNG Porto Alegre')));
  assert.ok(drawnTexts.some((t) => t === '620.4'));
  assert.ok(drawnTexts.some((t) => t === '310.2'));
  assert.ok(drawnTexts.some((t) => t.includes('11 ms')));
  assert.ok(drawnTexts.some((t) => t.includes('Δ +12 ms')));
  assert.ok(drawnTexts.some((t) => t.includes('Excelente')));
});

test('shareTestResult suporta Web Share com arquivo PNG (mobile), download automático (desktop) e cancelamento', async () => {
  const sample = createSampleResult();
  const fakeBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  const renderBlob = async () => fakeBlob;

  class MockFile {
    constructor(parts, name, opts) {
      this.parts = parts;
      this.name = name;
      this.type = opts?.type;
    }
  }

  // Caminho 1: Mobile com Web Share suportando files
  let sharedPayload = null;
  const mobileRes = await shareTestResult(
    sample,
    { ispName: 'TestAi', serverLabel: 'Cloudflare Edge' },
    {
      FileCtor: MockFile,
      renderBlob,
      navigatorObj: {
        canShare(data) {
          return Array.isArray(data?.files) && data.files.length === 1;
        },
        async share(data) {
          sharedPayload = data;
        }
      }
    }
  );
  assert.equal(mobileRes.status, 'shared');
  assert.match(mobileRes.filename, /^testai-resultado-\d{8}-\d{4}\.png$/);
  assert.equal(sharedPayload.files[0].name, mobileRes.filename);
  assert.equal(sharedPayload.files[0].type, 'image/png');
  assert.match(sharedPayload.text, /620\.4 Mbps/);

  // Caminho 2: Cancelamento nativo (AbortError) não lança exceção e não cai em download
  const cancelRes = await shareTestResult(sample, undefined, {
    FileCtor: MockFile,
    renderBlob,
    navigatorObj: {
      canShare: () => true,
      async share() {
        const err = new Error('User cancelled');
        err.name = 'AbortError';
        throw err;
      }
    }
  });
  assert.equal(cancelRes.status, 'cancelled');

  // Caminho 3: Desktop sem Web Share cai em download automático do PNG
  let downloadedAnchor = null;
  let revokedUrl = null;
  const desktopRes = await shareTestResult(sample, undefined, {
    renderBlob,
    navigatorObj: {},
    urlApi: {
      createObjectURL() {
        return 'blob:testai-card-1';
      },
      revokeObjectURL(url) {
        revokedUrl = url;
      }
    },
    doc: {
      body: {
        appendChild() {},
        removeChild() {}
      },
      createElement(tag) {
        assert.equal(tag, 'a');
        return {
          style: {},
          href: '',
          download: '',
          click() {
            downloadedAnchor = { href: this.href, download: this.download };
          },
          remove() {}
        };
      }
    }
  });

  assert.equal(desktopRes.status, 'downloaded');
  assert.equal(downloadedAnchor.href, 'blob:testai-card-1');
  assert.equal(downloadedAnchor.download, buildShareFilename(sample));
  assert.equal(revokedUrl, 'blob:testai-card-1');
});

test('index.html inclui botão #shareResultBtn oculto por padrão na barra simples', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  assert.match(html, /id="shareResultBtn"\s+class="btn-secondary hidden"/);
});
