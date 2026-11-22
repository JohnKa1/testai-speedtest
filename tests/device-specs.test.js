import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMockOnlineSources, makeResult } from './helpers.js';
import {
  deriveDeviceCategory,
  deriveWifiBandAverages,
  evaluateDeviceComparison,
  normalizeSpecText
} from '../src/diagnostics/capability-advisor.js';
import { DeviceSpecsService } from '../src/services/device-specs.service.js';
import {
  MAX_CACHE_ENTRIES,
  RATE_LIMIT_MAX_REQUESTS,
  clearDeviceSpecsCache,
  clearDeviceSpecsRateLimit,
  fetchFromMobileApi,
  getDeviceSpecsCacheSize,
  handler as deviceSpecsHandler,
  parseWifiBands,
  parseWifiGeneration,
  selectBestMobileApiMatch
} from '../api/device-specs.js';
import { METRIC_STATUS } from '../src/utils/validators.js';

describe('TestAi — Inteligência de Dispositivos e API /api/device-specs', () => {
  beforeEach(() => {
    clearDeviceSpecsCache();
  });

  it('encontra tanto flagships por palavras-chave invertidas (S25 galaxy) quanto aparelhos regionais/antigos (Moto E22, Positivo Twist)', async () => {
    const service = new DeviceSpecsService({
      proxyUrl: null,
      fetchImpl: createMockOnlineSources()
    });

    const s25 = await service.lookupDevice('S25 galaxy');
    assert.equal(s25.status, 'found');
    assert.equal(s25.device.wifi.generation, 'Wi-Fi 7');

    const motoE22 = await service.lookupDevice('moto e22');
    assert.equal(motoE22.status, 'found');
    assert.equal(motoE22.device.manufacturer, 'Motorola');
    assert.ok(motoE22.device.regionalVariant.includes('XT2239-10'));

    const positivo = await service.lookupDevice('positivo twist');
    assert.equal(positivo.status, 'found');
    assert.equal(positivo.device.manufacturer, 'Positivo');

    const unknown = await service.lookupDevice('Aparelho Fantasma 9999');
    assert.equal(unknown.status, 'not-found');
    assert.equal(unknown.device, null);
  });

  it('faz fallback automático para Wikipedia/Google Play quando /api/device-specs falha com erro de token (HTTP 502)', async () => {
    const fallbackOnline = createMockOnlineSources();
    const service = new DeviceSpecsService({
      proxyUrl: '/api/device-specs',
      fetchImpl: async (url, opts) => {
        if (String(url).startsWith('/api/device-specs')) {
          return {
            ok: false,
            status: 502,
            headers: { get: () => 'application/json' },
            json: async () => ({ error: 'Falha ao consultar MobileAPI.dev (HTTP 401)' })
          };
        }
        return fallbackOnline(url, opts);
      }
    });

    const s25 = await service.lookupDevice('Samsung Galaxy S25');
    assert.equal(s25.status, 'found');
    assert.equal(s25.origin, 'wikipedia-online');
    assert.equal(s25.device.wifi.generation, 'Wi-Fi 7');

    const motoE22 = await service.lookupDevice('moto e22');
    assert.equal(motoE22.status, 'found');
    assert.equal(motoE22.origin, 'google-play-registry');
    assert.equal(motoE22.device.manufacturer, 'Motorola');
  });

  it('distingue especificação teórica, estimativa favorável e velocidade medida na análise do dispositivo', async () => {
    const service = new DeviceSpecsService({
      proxyUrl: null,
      fetchImpl: createMockOnlineSources()
    });
    const { device } = await service.lookupDevice('Samsung Galaxy S25');
    const res = makeResult();
    res.metrics.download = { value: 300, status: METRIC_STATUS.MEASURED };

    const comparison = evaluateDeviceComparison(device, res);
    assert.ok(comparison.tiers.theoretical.includes('Wi-Fi 7'));
    assert.ok(comparison.tiers.measured.includes('300.0 Mbps'));
    assert.equal(comparison.category.tier, 'Alto Desempenho (Topo de Linha)');
    assert.ok(comparison.wifiBandAverages.band24.supported);
    assert.ok(comparison.wifiBandAverages.band5.supported);
    assert.ok(comparison.wifiBandAverages.band6.supported);
  });

  it('classifica corretamente categoria Básico / Médio / Alto Desempenho e deriva médias de Wi-Fi por banda (caso Galaxy A10, A06, A71 e S25 FE)', () => {
    const a10Device = {
      manufacturer: 'Samsung',
      model: 'Galaxy A10',
      wifi: { generation: 'Wi-Fi 4', standards: '802.11 b/g/n', bands: ['2,4 GHz'] },
      cellular: { has4G: true, has5G: false }
    };
    const catA10 = deriveDeviceCategory(a10Device);
    assert.equal(catA10.tier, 'Básico (Entrada)');
    assert.equal(catA10.badge, 'BÁSICO / ENTRADA');

    const bandsA10 = deriveWifiBandAverages(a10Device);
    assert.equal(bandsA10.band24.supported, true);
    assert.equal(bandsA10.band24.speedRange, '35 a 70 Mbps');
    assert.equal(bandsA10.band5.supported, false);
    assert.equal(bandsA10.band5.speedRange, 'Não suportado (apenas 2,4 GHz)');
    assert.equal(bandsA10.band6.supported, false);
    assert.equal(bandsA10.band6.speedRange, 'Não suportado');

    const resA10 = makeResult();
    resA10.metrics.download = { value: 48, status: METRIC_STATUS.MEASURED };
    resA10.metrics.upload = { value: 22, status: METRIC_STATUS.MEASURED };
    const compA10 = evaluateDeviceComparison(a10Device, resA10);
    assert.equal(compA10.verdictBadge, 'PRÓXIMO AO LIMITE DO APARELHO (2,4 GHz)');
    assert.ok(!compA10.tiers.theoretical.includes('Não divulgado'));
    assert.ok(!compA10.tiers.theoretical.includes('Informação não disponível'));
    assert.ok(!compA10.analysis.includes('Não divulgado'));

    assert.equal(deriveDeviceCategory({ manufacturer: 'Samsung', model: 'Galaxy A10s' }).tier, 'Básico (Entrada)');
    assert.equal(deriveDeviceCategory({ manufacturer: 'Samsung', model: 'Galaxy A06' }).tier, 'Básico (Entrada)');
    assert.equal(deriveDeviceCategory({ manufacturer: 'Xiaomi', model: 'Redmi 13C' }).tier, 'Básico (Entrada)');

    const a71Device = {
      manufacturer: 'Samsung',
      model: 'Galaxy A71',
      wifi: { generation: 'Wi-Fi 5', bands: ['2,4 GHz', '5 GHz'] },
      cellular: { has4G: true, has5G: true }
    };
    const catA71 = deriveDeviceCategory(a71Device);
    assert.equal(catA71.tier, 'Médio (Intermediário)');
    assert.equal(catA71.badge, 'INTERMEDIÁRIO / MÉDIO');

    const bandsA71 = deriveWifiBandAverages(a71Device);
    assert.equal(bandsA71.band24.supported, true);
    assert.equal(bandsA71.band24.speedRange, '45 a 85 Mbps');
    assert.equal(bandsA71.band5.supported, true);
    assert.equal(bandsA71.band5.speedRange, '220 a 450 Mbps');
    assert.equal(bandsA71.band6.supported, false);
    assert.equal(bandsA71.band6.speedRange, 'Não suportado');

    const s25Device = {
      manufacturer: 'Samsung',
      model: 'Galaxy S25',
      wifi: { generation: 'Wi-Fi 7', bands: ['2,4 GHz', '5 GHz', '6 GHz'], supports6Ghz: true },
      cellular: { has4G: true, has5G: true }
    };
    assert.equal(deriveDeviceCategory(s25Device).tier, 'Alto Desempenho (Topo de Linha)');

    const s25FeDevice = {
      manufacturer: 'Samsung',
      model: 'Galaxy S25 FE',
      wifi: { generation: 'Wi-Fi 6E', bands: ['2,4 GHz', '5 GHz', '6 GHz'], supports6Ghz: true },
      cellular: { has4G: true, has5G: true }
    };
    assert.equal(deriveDeviceCategory(s25FeDevice).tier, 'Alto Desempenho (Topo de Linha)');

    const bandsS25 = deriveWifiBandAverages(s25Device);
    assert.equal(bandsS25.band24.speedRange, '70 a 140 Mbps');
    assert.equal(bandsS25.band5.speedRange, '700 a 1.200 Mbps');
    assert.equal(bandsS25.band6.speedRange, '1.200 a 2.400+ Mbps');

    assert.equal(deriveDeviceCategory({ manufacturer: 'Motorola', model: 'Moto E22' }).tier, 'Básico (Entrada)');
    assert.equal(
      deriveDeviceCategory({ manufacturer: 'Apple', model: 'iPhone 11', wifi: { generation: 'Wi-Fi 6' } }).tier,
      'Alto Desempenho (Topo de Linha)'
    );

    assert.equal(
      deriveDeviceCategory({
        manufacturer: 'Custom',
        model: 'Phone X',
        hardware: { chipset: 'Qualcomm Snapdragon 8 Gen 3' }
      }).tier,
      'Alto Desempenho (Topo de Linha)'
    );
    assert.equal(
      deriveDeviceCategory({
        manufacturer: 'Custom',
        model: 'Phone Lite',
        hardware: { chipset: 'Exynos 7884' },
        cellular: { has4G: true, has5G: false }
      }).tier,
      'Básico (Entrada)'
    );
  });

  it('interpreta notação GSMArena/MobileAPI de gerações e bandas Wi-Fi (/6, /6e, /7)', () => {
    const g4 = parseWifiGeneration('Wi-Fi 802.11 b/g/n, Wi-Fi Direct');
    assert.equal(g4, 'Wi-Fi 4');
    assert.deepEqual(parseWifiBands('Wi-Fi 802.11 b/g/n, Wi-Fi Direct', g4), ['2,4 GHz']);

    const g5 = parseWifiGeneration('Wi-Fi 802.11 a/b/g/n/ac, dual-band');
    assert.equal(g5, 'Wi-Fi 5');
    assert.deepEqual(parseWifiBands('Wi-Fi 802.11 a/b/g/n/ac, dual-band', g5), ['2,4 GHz', '5 GHz']);

    const g6 = parseWifiGeneration('Wi-Fi 802.11 a/b/g/n/ac/6, dual-band');
    assert.equal(g6, 'Wi-Fi 6');
    assert.deepEqual(parseWifiBands('Wi-Fi 802.11 a/b/g/n/ac/6, dual-band', g6), ['2,4 GHz', '5 GHz']);

    const g6e = parseWifiGeneration('Wi-Fi 802.11 a/b/g/n/ac/6e, tri-band');
    assert.equal(g6e, 'Wi-Fi 6E');
    assert.deepEqual(parseWifiBands('Wi-Fi 802.11 a/b/g/n/ac/6e, tri-band', g6e), ['2,4 GHz', '5 GHz', '6 GHz']);

    const g7 = parseWifiGeneration('Wi-Fi 802.11 a/b/g/n/ac/6e/7, tri-band');
    assert.equal(g7, 'Wi-Fi 7');
    assert.deepEqual(parseWifiBands('Wi-Fi 802.11 a/b/g/n/ac/6e/7, tri-band', g7), ['2,4 GHz', '5 GHz', '6 GHz']);
  });

  it('alterna autenticação na MobileAPI.dev sequencialmente sem conflito de cabeçalhos e para em falha de rede', async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url: String(url), headers: opts?.headers || {} });
      if (calls.length === 1) return { ok: false, status: 401 };
      if (calls.length === 2) return { ok: false, status: 403 };
      return { ok: true, status: 200, json: async () => ({ devices: [] }) };
    };

    const resp = await fetchFromMobileApi(
      new URL('https://api.mobileapi.dev/devices/search/?name=Galaxy%20A10'),
      'secret-key-123',
      { fetchImpl: mockFetch }
    );

    assert.equal(resp?.status, 200);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].headers.Authorization, 'Bearer secret-key-123');
    assert.equal(new URL(calls[0].url).searchParams.get('key'), null);
    assert.equal(calls[1].headers.Authorization, 'Token secret-key-123');
    assert.equal(new URL(calls[1].url).searchParams.get('key'), null);
    assert.equal(calls[2].headers.Authorization, undefined);
    assert.equal(calls[2].headers['X-API-Key'], undefined);
    assert.equal(new URL(calls[2].url).searchParams.get('key'), 'secret-key-123');

    let networkCalls = 0;
    const netResp = await fetchFromMobileApi(
      new URL('https://api.mobileapi.dev/devices/search/?name=Galaxy%20A10'),
      'secret-key-123',
      {
        fetchImpl: async () => {
          networkCalls += 1;
          throw new Error('network down');
        }
      }
    );
    assert.equal(netResp, null);
    assert.equal(networkCalls, 1);
  });

  it('endpoint /api/device-specs seleciona o modelo exato (Galaxy A10 vs A10s) e calcula categoria e bandas', async () => {
    const bestS25Fe = selectBestMobileApiMatch(
      [
        { id: 1, brand_name: 'Samsung', name: 'Galaxy S25' },
        { id: 2, brand_name: 'Samsung', name: 'Galaxy S25 FE' }
      ],
      'Galaxy S25 FE'
    );
    assert.equal(bestS25Fe?.name, 'Galaxy S25 FE');

    let capturedStatus = null;
    let capturedPayload = null;
    const req = { method: 'GET', url: '/api/device-specs?q=Galaxy%20A10' };
    const res = {
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end(body) {
        capturedStatus = this.statusCode;
        capturedPayload = JSON.parse(body);
      }
    };

    await deviceSpecsHandler(req, res, {
      apiKey: 'mock-server-key',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          devices: [
            {
              id: 10,
              brand_name: 'Samsung',
              name: 'Galaxy A10s',
              wlan: 'Wi-Fi 802.11 b/g/n',
              chipset: 'MediaTek Helio P22'
            },
            {
              id: 11,
              brand_name: 'Samsung',
              name: 'Galaxy A10',
              release_date: '2019-03',
              wlan: 'Wi-Fi 802.11 b/g/n',
              chipset: 'Exynos 7884',
              '4g_bands': '1, 3, 5, 7, 28'
            }
          ]
        })
      })
    });

    assert.equal(capturedStatus, 200);
    assert.equal(capturedPayload.device.model, 'Galaxy A10');
    assert.equal(capturedPayload.device.hardware.chipset, 'Exynos 7884');
    assert.equal(capturedPayload.device.category.tier, 'Básico (Entrada)');
    assert.equal(capturedPayload.device.wifiBandAverages.band24.speedRange, '35 a 70 Mbps');
    assert.equal(capturedPayload.device.wifiBandAverages.band5.supported, false);
    assert.equal(
      capturedPayload.device.wifiBandAverages.band5.speedRange,
      'Não suportado (apenas 2,4 GHz)'
    );
    assert.equal(capturedPayload.device.wifiBandAverages.band6.speedRange, 'Não suportado');
  });

  it('blinda /api/device-specs com cabeçalhos de segurança, ALLOWED_ORIGIN, rate limit (HTTP 429) e limite de cache (500)', async () => {
    const makeMockRes = () => ({
      statusCode: 200,
      headers: {},
      body: null,
      setHeader(k, v) {
        this.headers[String(k).toLowerCase()] = String(v);
      },
      end(raw) {
        this.body = JSON.parse(raw);
      }
    });

    const mockFetch = async (url) => {
      const name = new URL(String(url)).searchParams.get('name') || 'Device X';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          devices: [
            {
              id: name.toLowerCase().replace(/\s+/g, '-'),
              brand_name: 'TestBrand',
              name,
              wlan: 'Wi-Fi 802.11 a/b/g/n/ac'
            }
          ]
        })
      };
    };

    const blockedRes = makeMockRes();
    await deviceSpecsHandler(
      {
        method: 'GET',
        url: '/api/device-specs?q=Galaxy%20A71',
        headers: { origin: 'https://site-nao-autorizado.example', 'x-forwarded-for': '203.0.113.1' }
      },
      blockedRes,
      { apiKey: 'mock-key', allowedOrigin: 'https://testai.provedor.com.br', fetchImpl: mockFetch }
    );
    assert.equal(blockedRes.statusCode, 403);
    assert.equal(blockedRes.headers['x-content-type-options'], 'nosniff');
    assert.equal(blockedRes.headers['referrer-policy'], 'no-referrer');

    const allowedRes = makeMockRes();
    await deviceSpecsHandler(
      {
        method: 'GET',
        url: '/api/device-specs?q=Galaxy%20A71',
        headers: { origin: 'https://testai.provedor.com.br', 'x-forwarded-for': '203.0.113.2' }
      },
      allowedRes,
      { apiKey: 'mock-key', allowedOrigin: 'https://testai.provedor.com.br', fetchImpl: mockFetch }
    );
    assert.equal(allowedRes.statusCode, 200);
    assert.equal(allowedRes.headers['access-control-allow-origin'], 'https://testai.provedor.com.br');
    assert.equal(allowedRes.headers['x-content-type-options'], 'nosniff');
    assert.equal(allowedRes.headers['referrer-policy'], 'no-referrer');

    clearDeviceSpecsCache();
    clearDeviceSpecsRateLimit();

    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      const r = makeMockRes();
      await deviceSpecsHandler(
        {
          method: 'GET',
          url: '/api/device-specs?q=Galaxy%20A71',
          headers: { 'x-forwarded-for': '198.51.100.10' }
        },
        r,
        { apiKey: 'mock-key', allowedOrigin: '', fetchImpl: mockFetch }
      );
      assert.equal(r.statusCode, 200);
    }

    const throttledRes = makeMockRes();
    await deviceSpecsHandler(
      {
        method: 'GET',
        url: '/api/device-specs?q=Galaxy%20A71',
        headers: { 'x-forwarded-for': '198.51.100.10' }
      },
      throttledRes,
      { apiKey: 'mock-key', allowedOrigin: '', fetchImpl: mockFetch }
    );
    assert.equal(throttledRes.statusCode, 429);
    assert.equal(throttledRes.headers['retry-after'], '60');
    assert.ok(throttledRes.body.error.includes('Limite de consultas excedido'));

    const otherIpRes = makeMockRes();
    await deviceSpecsHandler(
      {
        method: 'GET',
        url: '/api/device-specs?q=Galaxy%20A71',
        headers: { 'x-forwarded-for': '198.51.100.11' }
      },
      otherIpRes,
      { apiKey: 'mock-key', allowedOrigin: '', fetchImpl: mockFetch }
    );
    assert.equal(otherIpRes.statusCode, 200);

    clearDeviceSpecsCache();
    clearDeviceSpecsRateLimit();

    for (let i = 0; i < MAX_CACHE_ENTRIES + 5; i++) {
      const r = makeMockRes();
      const ip = `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`;
      await deviceSpecsHandler(
        {
          method: 'GET',
          url: `/api/device-specs?q=ModeloTeste%20${i}`,
          headers: { 'x-forwarded-for': ip }
        },
        r,
        { apiKey: 'mock-key', allowedOrigin: '', fetchImpl: mockFetch }
      );
      assert.equal(r.statusCode, 200);
    }

    assert.equal(getDeviceSpecsCacheSize(), MAX_CACHE_ENTRIES);
  });

  it('normaliza &nbsp; e &#160; em hardwareSummary e no parser da Wikipedia', async () => {
    assert.equal(
      normalizeSpecText('Apple&nbsp;A18 · 8&#160;GB  LPDDR5X'),
      'Apple A18 · 8 GB LPDDR5X'
    );

    const deviceNbsp = {
      manufacturer: 'Apple',
      model: 'iPhone 16',
      hardware: {
        chipset: 'Apple&nbsp;A18',
        ram: '8&#160;GB\u00a0LPDDR5X'
      },
      wifi: { generation: 'Wi-Fi 7' }
    };
    const comp = evaluateDeviceComparison(deviceNbsp, makeResult());
    assert.equal(comp.hardwareSummary, 'Apple A18 · 8 GB LPDDR5X');

    const wikiService = new DeviceSpecsService({
      proxyUrl: null,
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        const action = parsed.searchParams.get('action');
        if (action === 'query' && parsed.searchParams.get('list') === 'search') {
          return {
            ok: true,
            json: async () => ({ query: { search: [{ title: 'Apple iPhone 16 Pro' }] } })
          };
        }
        return {
          ok: true,
          json: async () => ({
            query: {
              pages: {
                202: {
                  pageid: 202,
                  title: 'Apple iPhone 16 Pro',
                  revisions: [
                    {
                      slots: {
                        main: {
                          '*': `{{Infobox mobile phone
| name = iPhone 16 Pro
| manufacturer = Apple Inc.
| soc = Apple&nbsp;A18&#160;Pro
| memory = 8&nbsp;GB LPDDR5X
| connectivity = Wi-Fi 802.11 a/b/g/n/ac/ax/be
| networks = 5G, LTE
}}`
                        }
                      }
                    }
                  ]
                }
              }
            }
          })
        };
      }
    });

    const wikiFound = await wikiService.lookupDevice('iPhone 16 Pro');
    assert.equal(wikiFound.status, 'found');
    assert.equal(wikiFound.device.hardware.chipset, 'Apple A18 Pro');
    assert.equal(wikiFound.device.hardware.ram, '8 GB LPDDR5X');
  });
});
