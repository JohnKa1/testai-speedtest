import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const memoryStore = new Map();
globalThis.window = {
  localStorage: {
    getItem(key) {
      return memoryStore.has(key) ? memoryStore.get(key) : null;
    },
    setItem(key, value) {
      memoryStore.set(key, String(value));
    },
    removeItem(key) {
      memoryStore.delete(key);
    },
    clear() {
      memoryStore.clear();
    }
  }
};

import { evaluateConnection, DIAGNOSIS_CATALOG } from '../src/diagnostics/connection-diagnostics.js';
import { evaluateGamingReadiness } from '../src/diagnostics/gaming-analyzer.js';
import {
  deriveDeviceCategory,
  deriveWifiBandAverages,
  evaluateDeviceComparison,
  evaluatePracticalCapabilities
} from '../src/diagnostics/capability-advisor.js';
import { DeviceSpecsService } from '../src/services/device-specs.service.js';
import {
  appendHistoryRecord,
  clearHistory,
  compareHistoryRecords,
  exportHistoryCsv,
  exportHistoryJson,
  loadHistory,
  toHistoryRecord
} from '../src/storage/history.storage.js';
import { METRIC_STATUS } from '../src/utils/validators.js';

function makeResult(overrides = {}) {
  return {
    id: 'sess-test-001',
    timestamp: '2026-11-19T12:00:00.000Z',
    durationMs: 18500,
    incomplete: false,
    profile: { id: 'standard', label: 'Padrão Adaptativo' },
    context: { linkType: 'ethernet', contractedMbps: 500, notes: '' },
    transfer: { totalDownloadBytes: 120_000_000, totalUploadBytes: 40_000_000 },
    metrics: {
      download: { value: 480, status: METRIC_STATUS.MEASURED },
      upload: { value: 240, status: METRIC_STATUS.MEASURED },
      ping: { value: 7, status: METRIC_STATUS.MEASURED },
      jitter: { value: 1.4, status: METRIC_STATUS.MEASURED },
      downloadLatency: { value: 11, status: METRIC_STATUS.MEASURED },
      uploadLatency: { value: 12, status: METRIC_STATUS.MEASURED },
      downloadJitter: { value: 3.1, status: METRIC_STATUS.MEASURED },
      uploadJitter: { value: 3.8, status: METRIC_STATUS.MEASURED },
      downloadLatencyDelta: { value: 4, status: METRIC_STATUS.MEASURED },
      uploadLatencyDelta: { value: 5, status: METRIC_STATUS.MEASURED },
      peakDownload: { value: 510, status: METRIC_STATUS.MEASURED },
      peakUpload: { value: 260, status: METRIC_STATUS.MEASURED }
    },
    stats: {
      download: { count: 14, min: 410, p50: 465, p90: 480, max: 510, mean: 460, cv: 0.06 },
      upload: { count: 12, min: 205, p50: 230, p90: 240, max: 260, mean: 228, cv: 0.07 },
      unloadedLatency: { count: 20, min: 6, p50: 7, p90: 9, max: 11, mean: 7.4, cv: 0.14 },
      downloadLatency: { count: 15, min: 8, p50: 11, p90: 15, max: 18, mean: 11.5, cv: 0.2 },
      uploadLatency: { count: 15, min: 9, p50: 12, p90: 16, max: 20, mean: 12.2, cv: 0.21 }
    },
    series: {
      downloadPoints: Array.from({ length: 10 }, (_, i) => ({ mbps: 450 + i * 3, bytes: 10_000_000 })),
      uploadPoints: Array.from({ length: 10 }, (_, i) => ({ mbps: 220 + i * 2, bytes: 5_000_000 }))
    },
    ...overrides
  };
}

function createMockOnlineSources() {
  return async (url) => {
    const parsed = new URL(url, 'http://localhost');

    // Simula o catálogo oficial Google Play Certified Devices (jsDelivr)
    if (parsed.hostname.includes('jsdelivr.net')) {
      return {
        ok: true,
        json: async () => ({
          'SM-A065M': { brand: 'Samsung', name: 'Galaxy A06' },
          'SM-A065F': { brand: 'Samsung', name: 'Galaxy A06' },
          'XT2239-10': { brand: 'Motorola', name: 'moto e22' },
          'P610': { brand: 'Positivo', name: 'Twist 4 Pro' }
        })
      };
    }

    const action = parsed.searchParams.get('action');
    const list = parsed.searchParams.get('list');

    if (action === 'query' && list === 'search') {
      const srsearch = (parsed.searchParams.get('srsearch') || '').toLowerCase();
      if (srsearch.includes('s25') && srsearch.includes('galaxy')) {
        return {
          ok: true,
          json: async () => ({
            query: { search: [{ title: 'Samsung Galaxy S25' }] }
          })
        };
      }
      return { ok: true, json: async () => ({ query: { search: [] } }) };
    }

    if (action === 'query' && parsed.searchParams.get('prop') === 'revisions') {
      const titles = parsed.searchParams.get('titles') || '';
      if (titles.includes('Samsung Galaxy S25')) {
        return {
          ok: true,
          json: async () => ({
            query: {
              pages: {
                101: {
                  pageid: 101,
                  title: 'Samsung Galaxy S25',
                  revisions: [
                    {
                      slots: {
                        main: {
                          '*': `{{Infobox mobile phone
| name = Samsung Galaxy S25
| manufacturer = [[Samsung Electronics]]
| released = January 22, 2025
| networks = [[4G LTE|LTE]], [[5G]]
| connectivity = [[Wi-Fi]] 802.11 a/b/g/n/ac/ax/be ([[Wi-Fi 7]]), tri-band
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
    }

    return { ok: false, status: 404, json: async () => ({}) };
  };
}

describe('TestAi — Diagnóstico, Cards Práticos e Inteligência de Dispositivos', () => {
  beforeEach(() => {
    clearHistory();
  });

  it('classifica conexão Gigabit saudável sem falsos alertas', () => {
    const res = makeResult();
    const diag = evaluateConnection(res);
    assert.equal(diag.code, DIAGNOSIS_CATALOG.EXCELLENT);
    assert.equal(diag.severity, 'good');
  });

  it('detecta bufferbloat severo sob carga', () => {
    const res = makeResult();
    res.metrics.downloadLatency = { value: 98, status: METRIC_STATUS.MEASURED };
    res.metrics.downloadLatencyDelta = { value: 91, status: METRIC_STATUS.MEASURED };

    const diag = evaluateConnection(res);
    assert.equal(diag.code, DIAGNOSIS_CATALOG.POSSIBLE_BUFFERBLOAT);
    assert.equal(diag.severity, 'danger');
  });

  it('separa conclusão de Downloads vs. Jogos/Chamadas nos Cards Inteligentes quando há 300 Mbps com bufferbloat', () => {
    const res = makeResult();
    res.metrics.download = { value: 310, status: METRIC_STATUS.MEASURED };
    res.metrics.downloadLatencyDelta = { value: 85, status: METRIC_STATUS.MEASURED };

    const cards = evaluatePracticalCapabilities(res);
    const downloads = cards.find((c) => c.id === 'downloads');
    const realtime = cards.find((c) => c.id === 'realtime');

    assert.equal(downloads?.tone, 'good');
    assert.equal(realtime?.tone, 'danger');
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

  it('classifica corretamente categoria Básico / Médio / Alto Desempenho e deriva médias de Wi-Fi por banda (caso Galaxy A10, A71 e S25)', () => {
    // 1. Caso Galaxy A10 (Entrada / Básico - apenas 2,4 GHz)
    const a10Device = {
      manufacturer: 'Samsung',
      model: 'Galaxy A10',
      wifi: { generation: 'Wi-Fi 4', bands: ['2,4 GHz'] },
      cellular: { has4G: true, has5G: false }
    };
    const catA10 = deriveDeviceCategory(a10Device);
    assert.equal(catA10.tier, 'Básico (Entrada)');
    assert.equal(catA10.badge, 'BÁSICO / ENTRADA');

    const bandsA10 = deriveWifiBandAverages(a10Device);
    assert.equal(bandsA10.band24.supported, true);
    assert.equal(bandsA10.band24.speedRange, '35 a 70 Mbps');
    assert.equal(bandsA10.band5.supported, false);
    assert.equal(bandsA10.band6.supported, false);

    // 2. Caso Galaxy A71/A72 (Intermediário / Médio - dual-band 2,4 e 5 GHz)
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

    // 3. Caso Galaxy S25 (Topo de Linha / Flagship - Wi-Fi 7 tri-band)
    const s25Device = {
      manufacturer: 'Samsung',
      model: 'Galaxy S25',
      wifi: { generation: 'Wi-Fi 7', bands: ['2,4 GHz', '5 GHz', '6 GHz'], supports6Ghz: true },
      cellular: { has4G: true, has5G: true }
    };
    const catS25 = deriveDeviceCategory(s25Device);
    assert.equal(catS25.tier, 'Alto Desempenho (Topo de Linha)');

    const bandsS25 = deriveWifiBandAverages(s25Device);
    assert.equal(bandsS25.band24.supported, true);
    assert.equal(bandsS25.band24.speedRange, '70 a 140 Mbps');
    assert.equal(bandsS25.band5.supported, true);
    assert.equal(bandsS25.band5.speedRange, '700 a 1.200 Mbps');
    assert.equal(bandsS25.band6.supported, true);
    assert.equal(bandsS25.band6.speedRange, '1.200 a 2.400+ Mbps');

    // 4. Caso Moto E22 (Básico / Entrada)
    const motoE = { manufacturer: 'Motorola', model: 'Moto E22' };
    assert.equal(deriveDeviceCategory(motoE).tier, 'Básico (Entrada)');

    // 5. Caso iPhone 11 (Alto Desempenho)
    const iphone = { manufacturer: 'Apple', model: 'iPhone 11', wifi: { generation: 'Wi-Fi 6' } };
    assert.equal(deriveDeviceCategory(iphone).tier, 'Alto Desempenho (Topo de Linha)');
  });

  it('persiste e exporta histórico em JSON e CSV', () => {
    const res = makeResult();
    const diag = evaluateConnection(res);
    const gaming = evaluateGamingReadiness(res);

    const rec = toHistoryRecord(res, diag, gaming);
    const list = appendHistoryRecord(rec);
    assert.equal(list.length, 1);
    assert.equal(loadHistory().length, 1);

    const json = exportHistoryJson(list);
    const csv = exportHistoryCsv(list);
    assert.ok(json.includes('sess-test-001'));
    assert.ok(csv.includes('480'));

    const diff = compareHistoryRecords(rec, { ...rec, downloadMbps: 400 });
    assert.equal(diff.downloadDiffMbps, 80);
  });
});