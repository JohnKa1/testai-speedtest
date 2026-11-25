/**
 * Testes unitários para configuração white-label em tempo de execução (`runtime-config.js`)
 * e leitura dinâmica de endpoints em `SpeedTestService`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import './helpers.js';
import {
  DEFAULT_RUNTIME_CONFIG,
  getRuntimeConfig,
  getRuntimeState,
  loadRuntimeConfig,
  mergeRuntimeConfig,
  resolveRuntimeRoute,
  RUNTIME_ROUTES,
  setRuntimeConfig
} from '../src/services/runtime-config.js';
import { TEST_PROFILES } from '../src/config/speedtest.config.js';
import { SpeedTestService } from '../src/services/speedtest.service.js';

describe('TestAi — Configuração White-Label em Tempo de Execução (Etapa 1)', () => {
  it('public/config.json existe e define o schema padrão esperado', () => {
    const raw = fs.readFileSync(new URL('../public/config.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);

    assert.equal(parsed.ispName, 'TestAi');
    assert.equal(parsed.serverLabel, 'Cloudflare Edge');
    assert.equal(parsed.measurementMode, 'commercial');
    assert.deepEqual(parsed.parallelStreams, { download: 6, upload: 4 });
    assert.deepEqual(parsed.endpoints, {
      down: 'https://speed.cloudflare.com/__down',
      up: 'https://speed.cloudflare.com/__up',
      ping: 'https://speed.cloudflare.com/__down',
      meta: null
    });
  });

  it('carrega ./config.json válido com cache: no-store e aplica valores customizados', async () => {
    let requestedUrl = null;
    let requestedInit = null;

    const customPayload = {
      ispName: 'FibraSul Telecom',
      serverLabel: 'POP Curitiba 01',
      measurementMode: 'commercial',
      parallelStreams: { download: 8, upload: 6 },
      endpoints: {
        down: 'https://speed.fibrasul.example/down',
        up: 'https://speed.fibrasul.example/up',
        ping: 'https://speed.fibrasul.example/ping',
        meta: 'https://speed.fibrasul.example/meta'
      }
    };

    const config = await loadRuntimeConfig({
      fetchImpl: async (url, init) => {
        requestedUrl = url;
        requestedInit = init;
        return /** @type {any} */ ({
          ok: true,
          status: 200,
          json: async () => customPayload
        });
      }
    });

    assert.equal(requestedUrl, './config.json');
    assert.equal(requestedInit?.cache, 'no-store');
    assert.equal(config.ispName, 'FibraSul Telecom');
    assert.equal(config.serverLabel, 'POP Curitiba 01');
    assert.equal(config.measurementMode, 'commercial');
    assert.deepEqual(config.parallelStreams, { download: 8, upload: 6 });
    assert.deepEqual(config.endpoints, customPayload.endpoints);
  });

  it('faz fallback seguro para DEFAULT_RUNTIME_CONFIG quando fetch falha ou retorna erro HTTP', async () => {
    const networkFailConfig = await loadRuntimeConfig({
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      }
    });
    assert.deepEqual(networkFailConfig, DEFAULT_RUNTIME_CONFIG);

    const http404Config = await loadRuntimeConfig({
      fetchImpl: async () =>
        /** @type {any} */ ({
          ok: false,
          status: 404,
          json: async () => ({ ispName: 'Ignorado' })
        })
    });
    assert.deepEqual(http404Config, DEFAULT_RUNTIME_CONFIG);

    const malformedJsonConfig = await loadRuntimeConfig({
      fetchImpl: async () =>
        /** @type {any} */ ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token');
          }
        })
    });
    assert.deepEqual(malformedJsonConfig, DEFAULT_RUNTIME_CONFIG);
  });

  it('faz fallback de campos ausentes/inválidos alinhando DEFAULT_RUNTIME_CONFIG em commercial e expondo rota ativa', () => {
    assert.equal(DEFAULT_RUNTIME_CONFIG.measurementMode, 'commercial');

    const partial = mergeRuntimeConfig({
      ispName: '   Meu Provedor   ',
      measurementMode: 'modo-desconhecido',
      parallelStreams: { download: 0 },
      endpoints: { down: 'https://isp.local/down', ping: '' }
    });

    assert.equal(partial.ispName, 'Meu Provedor');
    assert.equal(partial.serverLabel, DEFAULT_RUNTIME_CONFIG.serverLabel);
    assert.equal(partial.measurementMode, 'commercial');
    assert.equal(partial.parallelStreams.download, DEFAULT_RUNTIME_CONFIG.parallelStreams.download);
    assert.equal(partial.parallelStreams.upload, DEFAULT_RUNTIME_CONFIG.parallelStreams.upload);
    assert.equal(partial.endpoints.down, 'https://isp.local/down');
    assert.equal(partial.endpoints.up, DEFAULT_RUNTIME_CONFIG.endpoints.up);
    assert.equal(partial.endpoints.ping, DEFAULT_RUNTIME_CONFIG.endpoints.ping);
    assert.equal(partial.endpoints.meta, null);
    assert.equal(resolveRuntimeRoute(partial), RUNTIME_ROUTES.ON_NET);
    assert.equal(resolveRuntimeRoute(DEFAULT_RUNTIME_CONFIG), RUNTIME_ROUTES.OFF_NET_FALLBACK);
  });

  it('loadRuntimeConfig aplica timeout curto sem travar o boot e expõe on-net vs off-net-fallback em getRuntimeState', async () => {
    const prevConfig = getRuntimeConfig();
    try {
      const timedOutConfig = await loadRuntimeConfig({
        timeoutMs: 45,
        fetchImpl: (_url, init) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), {
              once: true
            });
          })
      });
      assert.deepEqual(timedOutConfig, DEFAULT_RUNTIME_CONFIG);
      const fallbackState = getRuntimeState();
      assert.equal(fallbackState.ready, true);
      assert.equal(fallbackState.usedFallback, true);
      assert.equal(fallbackState.activeRoute, RUNTIME_ROUTES.OFF_NET_FALLBACK);

      const onNetConfig = await loadRuntimeConfig({
        timeoutMs: 200,
        fetchImpl: async () =>
          /** @type {any} */ ({
            ok: true,
            status: 200,
            json: async () => ({
              ispName: 'Fibra Pop',
              serverLabel: 'POP-01',
              measurementMode: 'commercial',
              endpoints: {
                down: '/api/down',
                up: '/api/up',
                ping: '/api/ping',
                meta: '/api/meta'
              }
            })
          })
      });
      assert.equal(onNetConfig.ispName, 'Fibra Pop');
      const onNetState = getRuntimeState();
      assert.equal(onNetState.ready, true);
      assert.equal(onNetState.usedFallback, false);
      assert.equal(onNetState.activeRoute, RUNTIME_ROUTES.ON_NET);
    } finally {
      setRuntimeConfig(prevConfig);
    }
  });

  it('SpeedTestService utiliza os endpoints de runtimeConfig sem usar speed.cloudflare.com quando customizado', async () => {
    const origLightOpts = TEST_PROFILES.light.options;
    TEST_PROFILES.light.options = {
      ...origLightOpts,
      loadedLatencyThrottle: 120,
      idlePingCount: 5,
      maxIdleLatencyMs: 250,
      pingTimeoutMs: 120,
      downloadDurationMs: 220,
      uploadDurationMs: 220,
      sampleIntervalMs: 40,
      rollingWindowMs: 200,
      rampDiscardMs: 40,
      downloadConcurrency: 1,
      uploadConcurrency: 1,
      initialDownloadBytes: 100_000,
      maxDownloadBytes: 100_000,
      initialUploadBytes: 50_000,
      maxUploadBytes: 50_000
    };

    const prevGlobalConfig = getRuntimeConfig();

    try {
      const customConfig = mergeRuntimeConfig({
        ispName: 'NetLocal ISP',
        serverLabel: 'Servidor Próprio BNG-01',
        endpoints: {
          down: 'https://speed.netlocal.test/download',
          up: 'https://speed.netlocal.test/upload',
          ping: 'https://speed.netlocal.test/ping',
          meta: 'https://speed.netlocal.test/meta'
        }
      });
      setRuntimeConfig(customConfig);

      const calledUrls = [];
      const mockFetch = async (url, init = {}) => {
        calledUrls.push(String(url));
        const parsed = new URL(String(url));

        if (parsed.searchParams.has('bytes') && parsed.searchParams.get('bytes') === '0') {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            text: async () => ''
          };
        }

        if (init.method === 'POST') {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            text: async () => ''
          };
        }

        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => new Uint8Array(64_000).buffer
        };
      };

      const finishPromise = new Promise((resolve, reject) => {
        const service = new SpeedTestService(
          {
            onFinish: (result) => resolve(result),
            onError: (err) => reject(new Error(err?.message || 'Erro no teste customizado'))
          },
          { fetchImpl: mockFetch, runtimeConfig: customConfig }
        );
        service.start('light');
      });

      const result = await finishPromise;
      assert.ok(result);
      assert.ok(calledUrls.length > 0);
      assert.equal(
        calledUrls.some((u) => u.includes('speed.cloudflare.com')),
        false,
        'Nenhuma requisição deve ir para speed.cloudflare.com quando endpoints customizados estão ativos'
      );
      assert.ok(
        calledUrls.some((u) => u.startsWith('https://speed.netlocal.test/ping')),
        'Sondas de latência devem consultar endpoints.ping'
      );
      assert.ok(
        calledUrls.some((u) => u.startsWith('https://speed.netlocal.test/download')),
        'Download workers devem consultar endpoints.down'
      );
      assert.ok(
        calledUrls.some((u) => u.startsWith('https://speed.netlocal.test/upload')),
        'Upload workers devem consultar endpoints.up'
      );
    } finally {
      TEST_PROFILES.light.options = origLightOpts;
      setRuntimeConfig(prevGlobalConfig);
    }
  });
});
