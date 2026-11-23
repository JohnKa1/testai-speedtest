/**
 * Testes unitários para o Modo Comercial (Etapa 2): P90 (NAT Boost / Burst),
 * execução multi-stream concorrente (`parallelStreams` 1..8), cancelamento
 * via `AbortController` e transparência dos indicadores sustentados (P50) no NOC.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import './helpers.js';
import { TEST_PROFILES } from '../src/config/speedtest.config.js';
import {
  getRuntimeConfig,
  mergeRuntimeConfig,
  setRuntimeConfig
} from '../src/services/runtime-config.js';
import { createRunAccumulator, SpeedTestService } from '../src/services/speedtest.service.js';
import { renderTechnicalPanel } from '../src/ui/diagnostics-view.js';
import {
  computeP50Mbps,
  computeP90Mbps,
  resolvePrimaryAndPeakSpeed
} from '../src/utils/formatters.js';
import { METRIC_STATUS } from '../src/utils/validators.js';

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

describe('TestAi — Motor Comercial: NAT Boost / P90 e Multi-stream (Etapa 2)', () => {
  it('calcula P90 vs P50 corretamente em cenário com burst inicial (NAT Boost)', () => {
    const burstValuesMbps = [900, 880, 850, 500, 480, 460, 450, 440, 430, 420];
    const points = burstValuesMbps.map((mbps, idx) => ({
      bps: mbps * 1_000_000,
      mbps,
      elapsedMs: (idx + 1) * 200
    }));

    const p90 = computeP90Mbps(points);
    const p50 = computeP50Mbps(points);
    assert.equal(p90, 882);
    assert.equal(p50, 470);
    assert.ok(p90 > p50);

    // No modo comercial, amostras iniciais de burst (< 1000 ms) são preservadas e retorna P90
    const commAcc = createRunAccumulator({ measurementMode: 'commercial', rampDiscardMs: 1000 });
    commAcc.state.downloadPoints.push(...points);
    commAcc.state.uploadPoints.push(...points);

    assert.equal(commAcc.getDownloadBandwidthPoints().length, 10);
    assert.equal(Math.round(commAcc.getDownloadBandwidth() / 1_000_000), 882);
    assert.equal(Math.round(commAcc.getSustainedDownloadBandwidth() / 1_000_000), 470);
    assert.equal(commAcc.getSummary().measurementMode, 'commercial');

    // No modo sustentado, descarta ramp-up (< 1000 ms), preserva média no retorno padrão e P50 em sustentado
    const sustAcc = createRunAccumulator({
      measurementMode: 'sustained',
      rampDiscardMs: 1000,
      bandwidthPercentile: 0.5
    });
    sustAcc.state.downloadPoints.push(...points);
    assert.equal(sustAcc.getDownloadBandwidthPoints().length, 6);
    assert.equal(Math.round(sustAcc.getSustainedDownloadBandwidth() / 1_000_000), 445);
    assert.ok(sustAcc.getDownloadBandwidth() < commAcc.getDownloadBandwidth());
  });

  it('measurementMode "commercial" usa P90 no placar principal e preserva P50, pico e latência sob carga nos detalhes', async () => {
    const origLightOpts = TEST_PROFILES.light.options;
    TEST_PROFILES.light.options = {
      ...origLightOpts,
      loadedLatencyThrottle: 120,
      idlePingCount: 5,
      maxIdleLatencyMs: 250,
      pingTimeoutMs: 120,
      downloadDurationMs: 640,
      uploadDurationMs: 640,
      sampleIntervalMs: 40,
      rollingWindowMs: 220,
      rampDiscardMs: 220,
      downloadConcurrency: 2,
      uploadConcurrency: 2
    };

    const prevDocument = globalThis.document;
    const prevGlobalConfig = getRuntimeConfig();

    try {
      const commercialConfig = mergeRuntimeConfig({
        ispName: 'BurstNet ISP',
        serverLabel: 'POP Boost 01',
        measurementMode: 'commercial',
        parallelStreams: { download: 3, upload: 2 }
      });
      setRuntimeConfig(commercialConfig);

      let dlPhaseStart = null;
      let ulPhaseStart = null;

      const mockFetch = async (url, init = {}) => {
        const parsed = new URL(String(url));
        const during = parsed.searchParams.get('during');

        if (parsed.searchParams.get('bytes') === '0') {
          await abortableDelay(during === 'idle' ? 3 : 8, init.signal);
          return {
            ok: true,
            status: 200,
            headers: new Headers({
              'server-timing':
                during === 'idle'
                  ? 'cfSpeedEdge;dur=1, cfL4;desc="?rtt=5000"'
                  : 'cfSpeedEdge;dur=1, cfL4;desc="?rtt=14000"'
            }),
            text: async () => ''
          };
        }

        if (init.method === 'POST') {
          if (ulPhaseStart === null) ulPhaseStart = performance.now();
          const inBurst = performance.now() - ulPhaseStart < 240;
          await abortableDelay(inBurst ? 18 : 110, init.signal);
          return { ok: true, status: 200, headers: new Headers(), text: async () => '' };
        }

        if (dlPhaseStart === null) dlPhaseStart = performance.now();
        const inBurst = performance.now() - dlPhaseStart < 240;
        const size = inBurst ? 320_000 : 20_000;
        await abortableDelay(inBurst ? 20 : 85, init.signal);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => new Uint8Array(size).buffer
        };
      };

      const result = await new Promise((resolve, reject) => {
        const svc = new SpeedTestService(
          {
            onFinish: resolve,
            onError: (err) => reject(new Error(err?.message || 'Falha inesperada no modo comercial'))
          },
          { fetchImpl: mockFetch, runtimeConfig: commercialConfig }
        );
        svc.start('light');
      });

      assert.equal(result.measurementMode, 'commercial');
      assert.deepEqual(result.parallelStreams, { download: 3, upload: 2 });
      assert.ok(result.stats.download && result.stats.download.count >= 4);
      assert.ok(result.stats.upload && result.stats.upload.count >= 3);

      // Valor principal do motor é P90 e supera a velocidade sustentada (P50) no cenário com burst
      assert.ok(Math.abs(result.metrics.download.value - result.stats.download.p90) < 1e-6);
      assert.ok(
        result.metrics.download.value > result.stats.download.p50,
        `Esperado P90 (${result.metrics.download.value}) > P50 (${result.stats.download.p50})`
      );
      assert.ok(Math.abs(result.metrics.upload.value - result.stats.upload.p90) < 1e-6);

      // Pico e métricas de latência/jitter/bufferbloat permanecem intactos nos detalhes
      assert.ok(result.stats.download.max >= result.metrics.download.value);
      assert.equal(result.metrics.ping.status, METRIC_STATUS.MEASURED);
      assert.equal(result.metrics.jitter.status, METRIC_STATUS.MEASURED);
      assert.equal(result.metrics.downloadLatency.status, METRIC_STATUS.MEASURED);
      assert.equal(result.metrics.uploadLatency.status, METRIC_STATUS.MEASURED);
      assert.equal(result.metrics.downloadLatencyDelta.status, METRIC_STATUS.MEASURED);

      // resolvePrimaryAndPeakSpeed reflete P90 + sustained (P50)
      const resolvedDl = resolvePrimaryAndPeakSpeed(
        result.series.downloadPoints,
        result.metrics.download,
        result.stats.download,
        { measurementMode: 'commercial' }
      );
      assert.ok(Math.abs(resolvedDl.primary - result.stats.download.p90) < 1e-6);
      assert.ok(Math.abs(resolvedDl.sustained - result.stats.download.p50) < 1e-6);
      assert.ok(Math.abs(resolvedDl.peak - result.stats.download.max) < 1e-6);

      // Transparência na UI NOC: renderTechnicalPanel mostra P90 e Sustentado (P50) via textContent
      const makeMockEl = (tag) => ({
        tagName: tag.toUpperCase(),
        className: '',
        textContent: '',
        children: [],
        get firstChild() {
          return this.children[0] || null;
        },
        appendChild(ch) {
          this.children.push(ch);
          return ch;
        },
        removeChild(ch) {
          const i = this.children.indexOf(ch);
          if (i >= 0) this.children.splice(i, 1);
          return ch;
        }
      });

      const tbody = makeMockEl('tbody');
      const ctxGrid = makeMockEl('div');
      const sessionIdEl = makeMockEl('span');
      const byId = {
        techMetricsBody: tbody,
        techContextGrid: ctxGrid,
        techSessionId: sessionIdEl
      };

      globalThis.document = /** @type {any} */ ({
        getElementById: (id) => byId[id] || null,
        createElement: (tag) => makeMockEl(tag)
      });

      renderTechnicalPanel(result);

      const rowNames = tbody.children.map((tr) => tr.children[0]?.textContent);
      assert.ok(rowNames.includes('Download (P90 · Comercial)'));
      assert.ok(rowNames.includes('Download Sustentado (P50)'));
      assert.ok(rowNames.includes('Upload (P90 · Comercial)'));
      assert.ok(rowNames.includes('Upload Sustentado (P50)'));

      const metaKeys = ctxGrid.children.map((item) => item.children[0]?.textContent);
      assert.ok(metaKeys.includes('Modo de Medição'));
      assert.ok(metaKeys.includes('Streams Paralelos'));
    } finally {
      globalThis.document = prevDocument;
      TEST_PROFILES.light.options = origLightOpts;
      setRuntimeConfig(prevGlobalConfig);
    }
  });

  it('measurementMode "sustained" mantém média sustentada como métrica principal sem promover P90', async () => {
    const origLightOpts = TEST_PROFILES.light.options;
    TEST_PROFILES.light.options = {
      ...origLightOpts,
      loadedLatencyThrottle: 120,
      idlePingCount: 5,
      maxIdleLatencyMs: 250,
      pingTimeoutMs: 120,
      downloadDurationMs: 560,
      uploadDurationMs: 560,
      sampleIntervalMs: 40,
      rollingWindowMs: 220,
      rampDiscardMs: 120,
      downloadConcurrency: 2,
      uploadConcurrency: 2
    };

    const prevGlobalConfig = getRuntimeConfig();

    try {
      const sustainedConfig = mergeRuntimeConfig({
        measurementMode: 'sustained',
        parallelStreams: { download: 6, upload: 4 }
      });

      let chunkIdx = 0;
      const mockFetch = async (url, init = {}) => {
        const parsed = new URL(String(url));
        if (parsed.searchParams.get('bytes') === '0') {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            text: async () => ''
          };
        }
        if (init.method === 'POST') {
          await abortableDelay(25, init.signal);
          return { ok: true, status: 200, headers: new Headers(), text: async () => '' };
        }
        chunkIdx += 1;
        await abortableDelay(20 + (chunkIdx % 3) * 15, init.signal);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => new Uint8Array(64_000).buffer
        };
      };

      const result = await new Promise((resolve, reject) => {
        const svc = new SpeedTestService(
          {
            onFinish: resolve,
            onError: (err) => reject(new Error(err?.message || 'Erro inesperado no modo sustentado'))
          },
          { fetchImpl: mockFetch, runtimeConfig: sustainedConfig }
        );
        svc.start('light');
      });

      assert.equal(result.measurementMode, 'sustained');
      assert.deepEqual(result.parallelStreams, { download: 2, upload: 2 });
      assert.ok(result.stats.download && result.stats.download.count >= 4);
      assert.ok(
        Math.abs(result.metrics.download.value - result.stats.download.mean) < 1e-6,
        `Modo sustentado deve preservar média (${result.stats.download.mean}), obteve ${result.metrics.download.value}`
      );
      assert.ok(Math.abs(result.metrics.upload.value - result.stats.upload.mean) < 1e-6);
      assert.ok(result.stats.download.p50 > 0);
      assert.ok(result.metrics.download.value <= result.stats.download.p90 + 1e-6);
    } finally {
      TEST_PROFILES.light.options = origLightOpts;
      setRuntimeConfig(prevGlobalConfig);
    }
  });

  it('executa parallelStreams > 1 com trava segura (1..8) e aborta todos os streams via AbortController', async () => {
    // 1. Trava segura 1..8 na configuração em tempo de execução
    const clampedHigh = mergeRuntimeConfig({
      measurementMode: 'commercial',
      parallelStreams: { download: 32, upload: 0 }
    });
    assert.deepEqual(clampedHigh.parallelStreams, { download: 8, upload: 4 });

    const clampedMin = mergeRuntimeConfig({
      parallelStreams: { download: -3, upload: 12 }
    });
    assert.deepEqual(clampedMin.parallelStreams, { download: 6, upload: 8 });

    // 2. Execução concorrente com 4 workers download + 3 upload e probes de latência
    const origLightOpts = TEST_PROFILES.light.options;
    TEST_PROFILES.light.options = {
      ...origLightOpts,
      loadedLatencyThrottle: 80,
      idlePingCount: 4,
      maxIdleLatencyMs: 200,
      pingTimeoutMs: 120,
      downloadDurationMs: 560,
      uploadDurationMs: 560,
      sampleIntervalMs: 40,
      rollingWindowMs: 220,
      rampDiscardMs: 100
    };

    try {
      const seenDownloadWorkers = new Set();
      const seenUploadWorkers = new Set();
      let loadedPingSeen = false;

      const multiConfig = mergeRuntimeConfig({
        measurementMode: 'commercial',
        parallelStreams: { download: 4, upload: 3 }
      });

      const mockFetch = async (url, init = {}) => {
        const parsed = new URL(String(url));
        if (parsed.searchParams.get('bytes') === '0') {
          if (parsed.searchParams.get('during') === 'download') {
            loadedPingSeen = true;
          }
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            text: async () => ''
          };
        }
        const w = parsed.searchParams.get('w');
        if (init.method === 'POST') {
          if (w !== null) seenUploadWorkers.add(w);
          await abortableDelay(25, init.signal);
          return { ok: true, status: 200, headers: new Headers(), text: async () => '' };
        }
        if (w !== null) seenDownloadWorkers.add(w);
        await abortableDelay(25, init.signal);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => new Uint8Array(64_000).buffer
        };
      };

      const res = await new Promise((resolve, reject) => {
        const svc = new SpeedTestService(
          {
            onFinish: resolve,
            onError: (err) => reject(new Error(err?.message || 'Erro inesperado multi-stream'))
          },
          { fetchImpl: mockFetch, runtimeConfig: multiConfig }
        );
        svc.start('light');
      });

      assert.deepEqual(res.parallelStreams, { download: 4, upload: 3 });
      assert.equal(seenDownloadWorkers.size, 4);
      assert.equal(seenUploadWorkers.size, 3);
      assert.equal(loadedPingSeen, true);

      // Mesmo recebendo runtimeConfig não normalizado > 8, SpeedTestService aplica trava em 8
      const svcCheckCap = new SpeedTestService(
        {},
        {
          fetchImpl: mockFetch,
          runtimeConfig: {
            measurementMode: 'commercial',
            parallelStreams: { download: 25, upload: 19 },
            endpoints: multiConfig.endpoints
          }
        }
      );
      svcCheckCap.start('light');
      assert.equal(svcCheckCap.activeProfile.options.downloadConcurrency, 8);
      assert.equal(svcCheckCap.activeProfile.options.uploadConcurrency, 8);
      svcCheckCap.cancel();

      // 3. Cancelamento via AbortController aborta todos os sinais concorrentes sem vazar callbacks
      let cancelled = false;
      let leakedAfterCancel = false;
      const dlSignals = [];
      let allDlStartedResolve;
      const allDlStarted = new Promise((r) => {
        allDlStartedResolve = r;
      });

      const hangFetch = async (url, init = {}) => {
        const parsed = new URL(String(url));
        if (parsed.searchParams.get('bytes') === '0') {
          return { ok: true, status: 200, headers: new Headers(), text: async () => '' };
        }
        dlSignals.push(init.signal);
        if (dlSignals.length >= 4) {
          allDlStartedResolve();
        }
        await abortableDelay(5000, init.signal);
        return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
      };

      const cancelSvc = new SpeedTestService(
        {
          onCancel: () => {
            cancelled = true;
          },
          onFinish: () => {
            leakedAfterCancel = true;
          },
          onError: () => {
            leakedAfterCancel = true;
          }
        },
        { fetchImpl: hangFetch, runtimeConfig: multiConfig }
      );

      cancelSvc.start('light');
      await allDlStarted;
      cancelSvc.cancel();
      await new Promise((r) => setTimeout(r, 40));

      assert.equal(cancelled, true);
      assert.equal(leakedAfterCancel, false);
      assert.ok(dlSignals.length >= 4);
      assert.ok(dlSignals.every((sig) => sig.aborted === true));
    } finally {
      TEST_PROFILES.light.options = origLightOpts;
    }
  });
});
