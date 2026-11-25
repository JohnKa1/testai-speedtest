/**
 * Suíte de validação da Onda 1:
 * 1. RTT On-Net sub-milissegundo (< 0.5 ms preservado, ex.: 0.35 ms) e Server-Timing app;dur.
 * 2. Contabilização explícita de timeouts, failures, lossPct, maxMs e p95Ms nas fases de latência + espaçamento ocioso + trava HTTP/1.1 em 4 streams.
 * 3. Estatísticas consolidadas (`result.stats.download.p50`) no modo commercial livres do TCP Slow Start (< 1s).
 * 4. Monotonicidade estrita de `getEffectiveBytes` / `createUploadByteTracker` no upload multi-stream XHR.
 * 5. Bloqueio de race condition no boot (`setBootLoadingControls` / `main.js`) e headers de Widget/Deploy.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import './helpers.js';
import { TEST_PROFILES } from '../src/config/speedtest.config.js';
import { mergeRuntimeConfig } from '../src/services/runtime-config.js';
import {
  createRunAccumulator,
  createUploadByteTracker,
  isHttp1Protocol,
  MAX_HTTP1_SAFE_STREAMS,
  parseServerTiming,
  resolveNetworkRttMs,
  SpeedTestService,
  summarizeLatencyProbePhase
} from '../src/services/speedtest.service.js';
import { setBootLoadingControls } from '../src/ui/telemetry-view.js';
import { resolvePrimaryAndPeakSpeed } from '../src/utils/formatters.js';

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

describe('TestAi — Validação Obrigatória da Onda 1 (Motor, Boot e Deploy)', () => {
  it('1. resolveNetworkRttMs preserva latência On-Net sub-milissegundo (0.35 ms) e faz fallback apenas quando inválido', () => {
    // Sem Server-Timing: preserva resourceTtfbMs de 0.35 ms sem arredondar para >= 1 ms
    const onNetDirect = resolveNetworkRttMs({
      wallMs: 0.92,
      resourceTtfbMs: 0.35,
      serverTimingHeader: '',
      isLoaded: false
    });
    assert.equal(onNetDirect, 0.35);

    // Com Server-Timing do backend On-Net (`app;dur=0.070`): 0.42 - 0.07 = 0.35 ms
    const parsedApp = parseServerTiming('app;dur=0.070');
    assert.equal(parsedApp.serverMs, 0.07);
    assert.equal(parsedApp.tcpRttMs, null);

    const onNetSubtracted = resolveNetworkRttMs({
      wallMs: 1.4,
      resourceTtfbMs: 0.42,
      serverTimingHeader: 'app;dur=0.070',
      isLoaded: true
    });
    assert.equal(onNetSubtracted, 0.35);

    // Fallback para safeWallMs somente quando httpNet e tcpRttMs forem indisponíveis/inválidos (ex.: httpNet negativo)
    const fallbackWall = resolveNetworkRttMs({
      wallMs: 6.4,
      resourceTtfbMs: 1.2,
      serverTimingHeader: 'app;dur=3.0',
      isLoaded: false
    });
    assert.equal(fallbackWall, 6.4);
  });

  it('2. contabiliza attempts, succeeded, timeouts, failures, lossPct, maxMs e p95Ms quando sondas falham ou dão timeout', async () => {
    // Validação algébrica direta do sumarizador de fase
    const summary = summarizeLatencyProbePhase(
      { attempts: 10, succeeded: 7, timeouts: 2, failures: 3 },
      [10, 11, 12, 12, 14, 18, 42]
    );
    assert.equal(summary.attempts, 10);
    assert.equal(summary.succeeded, 7);
    assert.equal(summary.timeouts, 2);
    assert.equal(summary.failures, 3);
    assert.equal(summary.lossPct, 30);
    assert.equal(summary.maxMs, 42);
    assert.ok(summary.p95Ms !== null && summary.p95Ms >= 18 && summary.p95Ms <= 42);

    // Validação ponta a ponta no SpeedTestService com timeouts reais + falhas HTTP 502 nas sondas
    const origLightOpts = TEST_PROFILES.light.options;
    TEST_PROFILES.light.options = {
      ...origLightOpts,
      idlePingCount: 4,
      idlePingIntervalMs: 15,
      maxIdleLatencyMs: 450,
      pingTimeoutMs: 35,
      loadedLatencyThrottle: 60,
      downloadDurationMs: 460,
      uploadDurationMs: 460,
      sampleIntervalMs: 40,
      rollingWindowMs: 200,
      rampDiscardMs: 60,
      downloadConcurrency: 1,
      uploadConcurrency: 1
    };

    try {
      let idleCall = 0;
      let dlProbeCall = 0;
      let ulProbeCall = 0;
      const idleCallTimestamps = [];

      const mockFetch = async (url, init = {}) => {
        const parsed = new URL(String(url));
        const during = parsed.searchParams.get('during');

        if (parsed.searchParams.get('bytes') === '0') {
          if (during === 'warmup') {
            return { ok: true, status: 200, headers: new Headers(), text: async () => '' };
          }
          if (during === 'idle') {
            idleCall += 1;
            idleCallTimestamps.push(performance.now());
            if (idleCall === 2) {
              // Estoura pingTimeoutMs (35 ms) -> timeout explícito
              await abortableDelay(120, init.signal);
            }
            if (idleCall === 4) {
              // Erro HTTP 502 -> falha explícita
              return { ok: false, status: 502, headers: new Headers(), text: async () => '' };
            }
            return {
              ok: true,
              status: 200,
              headers: new Headers({ 'server-timing': 'cfSpeedEdge;dur=1, cfL4;desc="?rtt=8000"' }),
              text: async () => ''
            };
          }
          if (during === 'download') {
            dlProbeCall += 1;
            if (dlProbeCall === 1) {
              // Simula erro de rede (fetch rejeita sem abort externo)
              throw new Error('ECONNRESET');
            }
            return {
              ok: true,
              status: 200,
              headers: new Headers({ 'server-timing': 'cfSpeedEdge;dur=1, cfL4;desc="?rtt=25000"' }),
              text: async () => ''
            };
          }
          if (during === 'upload') {
            ulProbeCall += 1;
            return {
              ok: true,
              status: 200,
              headers: new Headers({ 'server-timing': 'cfSpeedEdge;dur=1, cfL4;desc="?rtt=19000"' }),
              text: async () => ''
            };
          }
        }

        if (init.method === 'POST') {
          await abortableDelay(25, init.signal);
          return { ok: true, status: 200, headers: new Headers(), text: async () => '' };
        }

        await abortableDelay(25, init.signal);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => new Uint8Array(64_000).buffer
        };
      };

      const onNetCfg = mergeRuntimeConfig({
        measurementMode: 'commercial',
        parallelStreams: { download: 2, upload: 2 },
        endpoints: {
          down: 'https://pop.isp.test/api/down',
          up: 'https://pop.isp.test/api/up',
          ping: 'https://pop.isp.test/api/ping'
        }
      });

      const result = await new Promise((resolve, reject) => {
        const svc = new SpeedTestService(
          {
            onFinish: resolve,
            onError: (err) => reject(new Error(err?.message || 'Erro inesperado'))
          },
          { fetchImpl: mockFetch, runtimeConfig: onNetCfg }
        );
        svc.start('light');
      });

      assert.equal(result.routeType, 'on-net');
      assert.ok(result.latencyProbes);

      // Fase ociosa: 6 tentativas (totalNeeded + 2 = 6), 4 sucedidas, 1 timeout e 2 falhas totais (33.33% loss)
      assert.equal(result.latencyProbes.idle.attempts, 6);
      assert.equal(result.latencyProbes.idle.succeeded, 4);
      assert.equal(result.latencyProbes.idle.timeouts, 1);
      assert.equal(result.latencyProbes.idle.failures, 2);
      assert.equal(result.latencyProbes.idle.lossPct, 33.33);
      assert.ok(result.latencyProbes.idle.maxMs !== null);
      assert.ok(result.latencyProbes.idle.p95Ms !== null);

      // Fase download carregado: teve 1 falha inicial contabilizada
      assert.ok(result.latencyProbes.download.attempts >= 2);
      assert.equal(result.latencyProbes.download.failures, 1);
      assert.ok(result.latencyProbes.download.lossPct > 0);

      // Verifica espaçamento mínimo entre sondas ociosas consecutivas
      assert.ok(idleCallTimestamps.length >= 2);
      assert.ok(idleCallTimestamps[1] - idleCallTimestamps[0] >= 10);
    } finally {
      TEST_PROFILES.light.options = origLightOpts;
    }
  });

  it('2b. reduz automaticamente concorrência de 6 para no máximo 4 streams quando nextHopProtocol é http/1.1', async () => {
    assert.equal(isHttp1Protocol('http/1.1'), true);
    assert.equal(isHttp1Protocol('http/1.0'), true);
    assert.equal(isHttp1Protocol('h2'), false);
    assert.equal(isHttp1Protocol('h3'), false);

    const origLightOpts = TEST_PROFILES.light.options;
    const origGetEntriesByName = performance.getEntriesByName;
    TEST_PROFILES.light.options = {
      ...origLightOpts,
      idlePingCount: 3,
      idlePingIntervalMs: 5,
      maxIdleLatencyMs: 200,
      pingTimeoutMs: 100,
      loadedLatencyThrottle: 90,
      downloadDurationMs: 460,
      uploadDurationMs: 460,
      sampleIntervalMs: 40,
      rollingWindowMs: 200,
      rampDiscardMs: 60
    };

    try {
      performance.getEntriesByName = () =>
        /** @type {any} */ ([
          {
            requestStart: 10,
            responseStart: 10.45,
            nextHopProtocol: 'http/1.1'
          }
        ]);

      const cfg6Streams = mergeRuntimeConfig({
        measurementMode: 'commercial',
        parallelStreams: { download: 6, upload: 6 },
        endpoints: {
          down: 'http://10.0.0.10:3001/api/down',
          up: 'http://10.0.0.10:3001/api/up',
          ping: 'http://10.0.0.10:3001/api/ping'
        }
      });

      const dlWorkers = new Set();
      const ulWorkers = new Set();

      const mockFetch = async (url, init = {}) => {
        const parsed = new URL(String(url));
        if (parsed.searchParams.get('bytes') === '0') {
          return { ok: true, status: 204, headers: new Headers(), text: async () => '' };
        }
        const w = parsed.searchParams.get('w');
        if (init.method === 'POST') {
          if (w !== null) ulWorkers.add(w);
          await abortableDelay(25, init.signal);
          return { ok: true, status: 200, headers: new Headers(), text: async () => '' };
        }
        if (w !== null) dlWorkers.add(w);
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
          { onFinish: resolve, onError: (e) => reject(new Error(e?.message || 'Erro')) },
          { fetchImpl: mockFetch, runtimeConfig: cfg6Streams }
        );
        svc.start('light');
      });

      assert.equal(MAX_HTTP1_SAFE_STREAMS, 4);
      assert.deepEqual(res.parallelStreams, { download: 4, upload: 4 });
      assert.equal(dlWorkers.size, 4);
      assert.equal(ulWorkers.size, 4);
      assert.equal(res.rawSummary.detectedProtocol, 'http/1.1');
      assert.equal(res.rawSummary.http1ConcurrencyCapped, true);
    } finally {
      performance.getEntriesByName = origGetEntriesByName;
      TEST_PROFILES.light.options = origLightOpts;
    }
  });

  it('3. result.stats.download.p50 no modo commercial descarta a rampa TCP Slow Start (< 1s) preservando a série visual', () => {
    // 3 amostras lentas de slow-start (< 1000 ms) seguidas de 5 amostras estáveis pós-warmup (>= 1000 ms)
    const dlSamples = [
      { bps: 45e6, mbps: 45, elapsedMs: 250, measTime: 250 },
      { bps: 110e6, mbps: 110, elapsedMs: 500, measTime: 500 },
      { bps: 210e6, mbps: 210, elapsedMs: 750, measTime: 750 },
      { bps: 500e6, mbps: 500, elapsedMs: 1000, measTime: 1000 },
      { bps: 520e6, mbps: 520, elapsedMs: 1250, measTime: 1250 },
      { bps: 540e6, mbps: 540, elapsedMs: 1500, measTime: 1500 },
      { bps: 560e6, mbps: 560, elapsedMs: 1750, measTime: 1750 },
      { bps: 580e6, mbps: 580, elapsedMs: 2000, measTime: 2000 }
    ];

    const acc = createRunAccumulator({ measurementMode: 'commercial', rampDiscardMs: 1000 });
    acc.state.downloadPoints.push(...dlSamples);
    acc.state.uploadPoints.push(...dlSamples);
    acc.state.unloadedLatencies.push(8, 9, 8, 9, 8);

    const svc = new SpeedTestService();
    svc.startedAt = performance.now() - 2500;
    const commProfile = {
      ...TEST_PROFILES.standard,
      options: {
        ...TEST_PROFILES.standard.options,
        measurementMode: 'commercial',
        rampDiscardMs: 1000
      }
    };

    const result = svc._buildConsolidatedResult(acc, commProfile, {}, false);

    // Série temporal mantém os 8 pontos completos para renderizar a curva no gráfico
    assert.equal(result.series.downloadPoints.length, 8);

    // Estatísticas consolidadas (stats.download) usam exclusivamente os 5 pontos pós-warmup [500, 520, 540, 560, 580]
    assert.equal(result.stats.download.count, 5);
    assert.equal(result.stats.download.min, 500);
    assert.equal(result.stats.download.p50, 540);
    assert.equal(result.stats.download.mean, 540);
    assert.equal(
      Math.round(result.rawSummary.sustainedDownload / 1e6),
      result.stats.download.p50
    );

    const resolved = resolvePrimaryAndPeakSpeed(
      result.series.downloadPoints,
      result.metrics.download,
      result.stats.download,
      { measurementMode: 'commercial' }
    );
    assert.equal(resolved.sustained, 540);
  });

  it('4. getEffectiveBytes no upload mantém monotonicidade estrita ao concluir o primeiro chunk com outros chunks em voo', async () => {
    // 4a. Teste determinístico de createUploadByteTracker reproduzindo o cenário exato da auditoria:
    // 4 workers com 450 KB em voo cada (1.800 KB total) quando o worker 0 conclui seu bloco de 512 KB.
    const tracker = createUploadByteTracker();
    tracker.addInFlight(450_000); // worker 0
    tracker.addInFlight(450_000); // worker 1
    tracker.addInFlight(450_000); // worker 2
    tracker.addInFlight(450_000); // worker 3

    const beforeFirstComplete = tracker.getEffectiveBytes();
    assert.equal(beforeFirstComplete, 1_800_000);

    // Worker 0 conclui bloco de 512 KB (remove seus 450 KB de inFlight e soma 512 KB em confirmed)
    tracker.confirmChunk(512_000, 450_000);
    const afterFirstComplete = tracker.getEffectiveBytes();
    assert.equal(tracker.getConfirmedBytes(), 512_000);
    assert.equal(tracker.getInFlightBytes(), 1_350_000);
    assert.equal(afterFirstComplete, 1_862_000);
    assert.ok(
      afterFirstComplete > beforeFirstComplete,
      'getEffectiveBytes deve crescer suavemente sem cair nem congelar quando o 1º chunk termina'
    );

    // Worker 1 avança mais 20 KB -> cresce imediatamente sem esperar terminar os outros 1.35 MB
    tracker.addInFlight(20_000);
    assert.equal(tracker.getEffectiveBytes(), 1_882_000);

    // Mesmo se um worker sofrer abort/stall no meio do envio, o watermark nunca regride
    tracker.abortChunk(470_000);
    assert.equal(tracker.getEffectiveBytes(), 1_882_000);

    // 4b. Integração com XMLHttpRequest simulado dentro do SpeedTestService
    const prevXhr = globalThis.XMLHttpRequest;
    const origLightOpts = TEST_PROFILES.light.options;
    TEST_PROFILES.light.options = {
      ...origLightOpts,
      idlePingCount: 2,
      idlePingIntervalMs: 5,
      maxIdleLatencyMs: 120,
      downloadDurationMs: 420,
      uploadDurationMs: 520,
      sampleIntervalMs: 40,
      rollingWindowMs: 200,
      rampDiscardMs: 60,
      downloadConcurrency: 1,
      uploadConcurrency: 3,
      initialUploadBytes: 500_000,
      maxUploadBytes: 500_000
    };

    const prevFetch = globalThis.fetch;
    try {
      let xhrSeq = 0;
      globalThis.XMLHttpRequest = /** @type {any} */ (
        class MockXhr {
          constructor() {
            this.id = ++xhrSeq;
            this.status = 0;
            this.upload = { onprogress: null };
            this.onload = null;
            this.onerror = null;
            this.onabort = null;
            this._timers = [];
          }
          open() {}
          send(payload) {
            const total = payload?.byteLength || 500_000;
            // Todos enviam 80% em voo rápido; o 1º termina em 45 ms enquanto os outros continuam em voo
            this._timers.push(
              setTimeout(() => {
                this.upload.onprogress?.({ loaded: Math.floor(total * 0.8) });
              }, 15)
            );
            const doneDelay = this.id === 1 ? 45 : 110;
            this._timers.push(
              setTimeout(() => {
                this.status = 200;
                this.onload?.();
              }, doneDelay)
            );
          }
          abort() {
            this._timers.forEach((t) => clearTimeout(t));
            this.onabort?.();
          }
        }
      );

      globalThis.fetch = /** @type {any} */ (
        async (url, init = {}) => {
          const parsed = new URL(String(url));
          if (parsed.searchParams.get('bytes') === '0') {
            return { ok: true, status: 204, headers: new Headers(), text: async () => '' };
          }
          await abortableDelay(20, init.signal);
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            arrayBuffer: async () => new Uint8Array(64_000).buffer
          };
        }
      );

      const xhrCfg = mergeRuntimeConfig({
        measurementMode: 'commercial',
        parallelStreams: { download: 1, upload: 3 },
        endpoints: {
          down: 'https://pop.isp.test/api/down',
          up: 'https://pop.isp.test/api/up',
          ping: 'https://pop.isp.test/api/ping'
        }
      });

      const res = await new Promise((resolve, reject) => {
        const svc = new SpeedTestService(
          { onFinish: resolve, onError: (e) => reject(new Error(e?.message || 'Erro XHR')) },
          { runtimeConfig: xhrCfg }
        );
        svc.start('light');
      });

      assert.ok(res.series.uploadPoints.length >= 3);
      assert.ok(res.metrics.upload.value > 0);
    } finally {
      globalThis.XMLHttpRequest = prevXhr;
      globalThis.fetch = prevFetch;
      TEST_PROFILES.light.options = origLightOpts;
    }
  });

  it('5. bloqueia botão de início durante boot e desbloqueia Modo Widget (?embed=1) nos headers de deploy', () => {
    const prevDoc = globalThis.document;
    const makeBtn = () => ({
      disabled: false,
      textContent: '',
      attrs: {},
      children: [],
      get firstChild() {
        return this.children[0] || null;
      },
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      removeChild(c) {
        this.children = this.children.filter((x) => x !== c);
        return c;
      }
    });

    const btnSimple = makeBtn();
    const btnAdv = makeBtn();
    const bodyClasses = new Set();

    try {
      globalThis.document = /** @type {any} */ ({
        body: {
          classList: {
            toggle(c, force) {
              if (force) bodyClasses.add(c);
              else bodyClasses.delete(c);
            }
          }
        },
        getElementById(id) {
          if (id === 'startBtnSimple') return btnSimple;
          if (id === 'startBtnAdv') return btnAdv;
          return null;
        },
        createElement: () => makeBtn(),
        createElementNS: () => makeBtn()
      });

      setBootLoadingControls(true);
      assert.equal(btnSimple.disabled, true);
      assert.equal(btnAdv.disabled, true);
      assert.equal(btnSimple.attrs['aria-busy'], 'true');
      assert.equal(bodyClasses.has('is-booting'), true);

      setBootLoadingControls(false);
      assert.equal(btnSimple.disabled, false);
      assert.equal(btnAdv.disabled, false);
      assert.equal(btnSimple.attrs['aria-busy'], 'false');
      assert.equal(bodyClasses.has('is-booting'), false);
    } finally {
      globalThis.document = prevDoc;
    }

    // Validação estrutural dos arquivos de deploy (Vercel, Nginx, Entrypoint e Caddy)
    const root = process.cwd();
    const vercelRaw = fs.readFileSync(path.join(root, 'vercel.json'), 'utf8');
    const vercel = JSON.parse(vercelRaw);
    const allVercelHeaders = vercel.headers.flatMap((h) => h.headers);
    assert.equal(
      allVercelHeaders.some((h) => h.key.toLowerCase() === 'x-frame-options'),
      false,
      'vercel.json não deve enviar X-Frame-Options: DENY'
    );
    const cspHeader = allVercelHeaders.find(
      (h) => h.key.toLowerCase() === 'content-security-policy'
    );
    assert.ok(cspHeader);
    assert.equal(cspHeader.value.includes("frame-ancestors 'none'"), false);
    assert.ok(cspHeader.value.includes('frame-ancestors *'));
    assert.ok(cspHeader.value.includes("connect-src 'self' https:"));

    const nginxConf = fs.readFileSync(path.join(root, 'deploy', 'nginx.conf'), 'utf8');
    assert.equal(/X-Frame-Options\s+"?DENY"?/i.test(nginxConf), false);
    assert.match(nginxConf, /X-Content-Type-Options\s+"nosniff"/);
    assert.match(nginxConf, /Referrer-Policy\s+"strict-origin-when-cross-origin"/);
    assert.match(nginxConf, /frame-ancestors\s+'self';/);
    assert.match(nginxConf, /location\s+\/api\/\s*\{[\s\S]*?gzip\s+off;[\s\S]*?proxy_buffering\s+off;[\s\S]*?Cache-Control\s+"no-store/);

    const entrypointSh = fs.readFileSync(path.join(root, 'deploy', 'entrypoint.sh'), 'utf8');
    assert.match(entrypointSh, /ALLOWED_FRAME_ANCESTORS/);

    const caddyfile = fs.readFileSync(path.join(root, 'Caddyfile'), 'utf8');
    assert.match(caddyfile, /ALLOWED_FRAME_ANCESTORS/);
    assert.match(caddyfile, /X-Content-Type-Options\s+"nosniff"/);
    assert.match(caddyfile, /Referrer-Policy\s+"strict-origin-when-cross-origin"/);
    assert.match(caddyfile, /handle\s+\/api\/\*[\s\S]*?Cache-Control\s+"no-store[\s\S]*?flush_interval\s+-1/);
    assert.match(caddyfile, /handle\s+\/config\.json[\s\S]*?Cache-Control\s+"no-store/);
  });
});
