import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMockOnlineSources, makeResult } from './helpers.js';
import {
  deriveDeviceCategory,
  deriveWifiBandAverages,
  evaluateDeviceComparison,
  normalizeSpecText
} from '../src/diagnostics/capability-advisor.js';
import { DeviceSpecsService } from '../src/services/device-specs.service.js';
import { METRIC_STATUS } from '../src/utils/validators.js';

describe('TestAi — Inteligência de Dispositivos (Wikipedia + Google Play)', () => {
  it('encontra tanto flagships por palavras-chave invertidas (S25 galaxy) quanto aparelhos regionais/antigos (Moto E22, Positivo Twist)', async () => {
    const service = new DeviceSpecsService({
      fetchImpl: createMockOnlineSources()
    });

    const s25 = await service.lookupDevice('S25 galaxy');
    assert.equal(s25.status, 'found');
    assert.equal(s25.origin, 'wikipedia-online');
    assert.equal(s25.device.wifi.generation, 'Wi-Fi 7');

    const motoE22 = await service.lookupDevice('moto e22');
    assert.equal(motoE22.status, 'found');
    assert.equal(motoE22.origin, 'google-play-registry');
    assert.equal(motoE22.device.manufacturer, 'Motorola');
    assert.ok(motoE22.device.regionalVariant.includes('XT2239-10'));

    const positivo = await service.lookupDevice('positivo twist');
    assert.equal(positivo.status, 'found');
    assert.equal(positivo.origin, 'google-play-registry');
    assert.equal(positivo.device.manufacturer, 'Positivo');

    const unknown = await service.lookupDevice('Aparelho Fantasma 9999');
    assert.equal(unknown.status, 'not-found');
    assert.equal(unknown.device, null);
  });

  it('faz fallback automático para o Google Play Registry quando a Wikipedia falha por erro de rede', async () => {
    const onlineSources = createMockOnlineSources();
    const service = new DeviceSpecsService({
      fetchImpl: async (url, opts) => {
        if (String(url).includes('wikipedia.org')) {
          throw new Error('Wikipedia offline');
        }
        return onlineSources(url, opts);
      }
    });

    const motoE22 = await service.lookupDevice('moto e22');
    assert.equal(motoE22.status, 'found');
    assert.equal(motoE22.origin, 'google-play-registry');
    assert.equal(motoE22.device.manufacturer, 'Motorola');
    assert.ok(motoE22.device.regionalVariant.includes('XT2239-10'));
  });

  it('distingue especificação teórica, estimativa favorável e velocidade medida na análise do dispositivo', async () => {
    const service = new DeviceSpecsService({
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
