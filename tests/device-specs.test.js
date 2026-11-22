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
import {
  createDevicePanelController,
  getBrandDisplayLabel,
  getBrandPlaceholderExample
} from '../src/ui/device-panel.js';

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

  it('bloqueia falsos positivos de modelos similares/antigos na Wikipedia e resolve o modelo exato', async () => {
    // Simula a Wikipedia retornando modelos parecidos/antigos quando o modelo exato não tem artigo próprio
    const noisyWikiFetch = async (url) => {
      const parsed = new URL(url, 'http://localhost');
      if (parsed.hostname.includes('jsdelivr.net')) {
        return {
          ok: true,
          json: async () => ({
            'XT2239-10': { brand: 'Motorola', name: 'moto e22' },
            'SM-A105M': { brand: 'Samsung', name: 'Galaxy A10' },
            'SM-A107M': { brand: 'Samsung', name: 'Galaxy A10s' }
          })
        };
      }

      const action = parsed.searchParams.get('action');
      const list = parsed.searchParams.get('list');
      if (action === 'query' && list === 'search') {
        // Wikipedia devolve artigos parecidos da mesma marca, mas NÃO o modelo pesquisado
        return {
          ok: true,
          json: async () => ({
            query: {
              search: [
                { title: 'Samsung Galaxy A10' },
                { title: 'Samsung Galaxy A series' },
                { title: 'Samsung Galaxy S25 FE' },
                { title: 'Moto E (1st generation)' },
                { title: 'Moto G5' },
                { title: 'Redmi Note 13' }
              ]
            }
          })
        };
      }

      if (action === 'query' && parsed.searchParams.get('prop') === 'revisions') {
        const titles = parsed.searchParams.get('titles') || '';
        const firstTitle = titles.split('|')[0];
        return {
          ok: true,
          json: async () => ({
            query: {
              pages: {
                999: {
                  pageid: 999,
                  title: firstTitle,
                  revisions: [
                    {
                      slots: {
                        main: {
                          '*': `{{Infobox mobile phone
| name = ${firstTitle}
| manufacturer = Generic
| connectivity = Wi-Fi 802.11 b/g/n/ac
| networks = 4G LTE
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

      return { ok: false, status: 404, json: async () => ({}) };
    };

    const service = new DeviceSpecsService({ fetchImpl: noisyWikiFetch });

    // 1. "Moto E22" NÃO deve aceitar "Moto E (1st generation)" nem "Moto G5" da Wikipedia; deve cair no Google Play Registry
    const e22 = await service.lookupDevice('Moto E22');
    assert.equal(e22.status, 'found');
    assert.equal(e22.origin, 'google-play-registry');
    assert.match(e22.device.model, /e22/i);
    assert.equal(e22.device.wifi.generation, 'Wi-Fi 5');

    // 2. "Galaxy A15 5G" NÃO deve aceitar "Galaxy A10" nem "Galaxy A55" da Wikipedia; deve resolver exatamente Galaxy A15 5G
    const a15 = await service.lookupDevice('Galaxy A15 5G');
    assert.equal(a15.status, 'found');
    assert.equal(a15.device.manufacturer, 'Samsung');
    assert.equal(a15.device.model, 'Galaxy A15 5G');
    assert.equal(a15.device.wifi.generation, 'Wi-Fi 5');
    assert.equal(a15.device.cellular.has5G, true);

    // 3. "Galaxy S25" (base) NÃO deve aceitar "Samsung Galaxy S25 FE" da Wikipedia
    const s25Base = await service.lookupDevice('Galaxy S25');
    assert.equal(s25Base.status, 'found');
    assert.equal(s25Base.device.model, 'Galaxy S25');
    assert.equal(s25Base.device.wifi.generation, 'Wi-Fi 7');

    // 4. "Redmi 13" NÃO deve aceitar "Redmi Note 13" da Wikipedia
    const redmi13 = await service.lookupDevice('Redmi 13');
    assert.equal(redmi13.status, 'found');
    assert.equal(redmi13.device.model, 'Redmi 13');

    // 5. Modelos inexistentes ("Galaxy A999", "iPhone 99") devem retornar not-found em vez de puxar modelo similar
    const fakeGalaxy = await service.lookupDevice('Galaxy A999');
    assert.equal(fakeGalaxy.status, 'not-found');
    assert.equal(fakeGalaxy.device, null);

    const fakeIphone = await service.lookupDevice('iPhone 99');
    assert.equal(fakeIphone.status, 'not-found');
    assert.equal(fakeIphone.device, null);

    // 6. Encontra modelos atuais e passados digitados de formas variadas (sem "Galaxy", sem "Redmi", com GB, colados, etc.)
    const currentAndPastQueries = [
      ['Samsung A54', 'Samsung', 'Galaxy A54', 'Wi-Fi 6'],
      ['Galaxy A55', 'Samsung', 'Galaxy A55', 'Wi-Fi 6'],
      ['Galaxy A56', 'Samsung', 'Galaxy A56', 'Wi-Fi 6'],
      ['Galaxy A35', 'Samsung', 'Galaxy A35', 'Wi-Fi 6'],
      ['Galaxy A16 5G', 'Samsung', 'Galaxy A16 5G', 'Wi-Fi 5'],
      ['Galaxy M55', 'Samsung', 'Galaxy M55', 'Wi-Fi 6'],
      ['Z Flip6', 'Samsung', 'Galaxy Z Flip 6', 'Wi-Fi 7'],
      ['Z Fold 6', 'Samsung', 'Galaxy Z Fold 6', 'Wi-Fi 7'],
      ['Motorola G84', 'Motorola', 'Moto G84', 'Wi-Fi 5'],
      ['Moto G85', 'Motorola', 'Moto G85', 'Wi-Fi 5'],
      ['Moto G75', 'Motorola', 'Moto G75', 'Wi-Fi 6'],
      ['Moto G54 256GB', 'Motorola', 'Moto G54', 'Wi-Fi 5'],
      ['Moto G35', 'Motorola', 'Moto G35', 'Wi-Fi 5'],
      ['Moto G04s', 'Motorola', 'Moto G04s', 'Wi-Fi 5'],
      ['Edge 50 Pro', 'Motorola', 'Edge 50 Pro', 'Wi-Fi 7'],
      ['Edge 40 Neo', 'Motorola', 'Edge 40 Neo', 'Wi-Fi 6E'],
      ['Razr 50 Ultra', 'Motorola', 'Razr 50 Ultra', 'Wi-Fi 7'],
      ['Xiaomi 14', 'Xiaomi', 'Xiaomi 14', 'Wi-Fi 7'],
      ['Xiaomi Note 13 Pro+', 'Xiaomi', 'Redmi Note 13 Pro Plus', 'Wi-Fi 6'],
      ['Note 13 Pro 5G', 'Xiaomi', 'Redmi Note 13 Pro 5G', 'Wi-Fi 6'],
      ['Xiaomi 13C', 'Xiaomi', 'Redmi 13C', 'Wi-Fi 5'],
      ['Redmi 14C', 'Xiaomi', 'Redmi 14C', 'Wi-Fi 5'],
      ['Poco X6 Pro', 'POCO', 'Poco X6 Pro', 'Wi-Fi 6E'],
      ['X6 Pro 5G', 'POCO', 'Poco X6 Pro 5G', 'Wi-Fi 6E'],
      ['Poco F6', 'POCO', 'Poco F6', 'Wi-Fi 6E'],
      ['Realme C67', 'Realme', 'Realme C67', 'Wi-Fi 5'],
      ['Realme 12 Pro+', 'Realme', 'Realme 12 Pro Plus', 'Wi-Fi 6'],
      ['Infinix Hot 40 Pro', 'Infinix', 'Infinix Hot 40 Pro', 'Wi-Fi 5'],
      ['Pixel 9 Pro', 'Google', 'Pixel 9 Pro', 'Wi-Fi 7'],
      ['Zenfone 10', 'Asus', 'Zenfone 10', 'Wi-Fi 7'],
      ['iPhone 15 128GB', 'Apple', 'iPhone 15', 'Wi-Fi 6'],
      ['iPhone 13 Mini', 'Apple', 'iPhone 13 Mini', 'Wi-Fi 6']
    ];

    for (const [q, expectedBrand, expectedModel, expectedWifi] of currentAndPastQueries) {
      const res = await service.lookupDevice(q);
      assert.equal(res.status, 'found', `Deveria encontrar "${q}"`);
      assert.equal(res.device.manufacturer, expectedBrand, `Marca incorreta para "${q}"`);
      assert.equal(res.device.model, expectedModel, `Modelo incorreto para "${q}"`);
      assert.equal(res.device.wifi.generation, expectedWifi, `Wi-Fi incorreto para "${q}"`);
    }
  });

  it('filtra aparelhos exclusivamente na janela 2015–2026 e opera em 2 etapas (Marca -> Sugestões instantâneas por tecla)', async () => {
    const service = new DeviceSpecsService({
      fetchImpl: createMockOnlineSources()
    });

    // Etapa 0: Bloqueio estrito de aparelhos anteriores a 2015
    for (const oldModel of ['iPhone 4s', 'iPhone 5s', 'iPhone 6', 'Galaxy S4', 'Galaxy S5', 'Galaxy Note 3', 'Moto G1', 'Moto G2']) {
      const resOld = await service.lookupDevice(oldModel);
      assert.equal(resOld.status, 'not-found', `Modelo pré-2015 "${oldModel}" não deve ser consultado`);
      assert.equal(resOld.origin, 'temporal-filter-2015-2026');
    }

    // Modelos de 2015 em diante continuam válidos
    const iphone6s = await service.lookupDevice('iPhone 6s', { brandId: 'apple' });
    assert.equal(iphone6s.status, 'found');
    assert.equal(iphone6s.device.model, 'iPhone 6s');

    // Etapa 1: Marcas clicáveis disponíveis
    const brands = service.getSupportedBrands();
    assert.ok(brands.length >= 7);
    assert.ok(brands.some((b) => b.id === 'samsung'));
    assert.ok(brands.some((b) => b.id === 'apple'));
    assert.ok(brands.some((b) => b.id === 'motorola'));
    assert.ok(brands.some((b) => b.id === 'xiaomi'));
    assert.ok(brands.some((b) => b.id === 'poco'));

    // Etapa 2: Ao escolher Apple e digitar "iPhone 15" (ou "15"), retorna as variantes clicáveis (iPhone 15, Plus, Pro, Pro Max)
    const apple15Suggestions = service.getBrandSuggestions('apple', 'iPhone 15');
    const apple15Models = apple15Suggestions.map((s) => s.model);
    assert.ok(apple15Models.includes('iPhone 15'));
    assert.ok(apple15Models.includes('iPhone 15 Plus'));
    assert.ok(apple15Models.includes('iPhone 15 Pro'));
    assert.ok(apple15Models.includes('iPhone 15 Pro Max'));

    // Ao escolher Samsung e digitar "A06", fica restrito apenas à Samsung e sugere Galaxy A06 / A06 5G
    const samsungA06Suggestions = service.getBrandSuggestions('samsung', 'A06');
    assert.ok(samsungA06Suggestions.length >= 1);
    assert.ok(samsungA06Suggestions.every((s) => s.manufacturer === 'Samsung'));
    assert.ok(samsungA06Suggestions.some((s) => s.model === 'Galaxy A06'));

    const scopedA06 = await service.lookupDevice('A06', { brandId: 'samsung' });
    assert.equal(scopedA06.status, 'found');
    assert.equal(scopedA06.device.manufacturer, 'Samsung');
    assert.equal(scopedA06.device.model, 'Galaxy A06');

    // Ao escolher Motorola e digitar apenas "84", resolve dentro da Motorola
    const scopedG84 = await service.lookupDevice('G84', { brandId: 'motorola' });
    assert.equal(scopedG84.status, 'found');
    assert.equal(scopedG84.device.manufacturer, 'Motorola');
    assert.equal(scopedG84.device.model, 'Moto G84');
  });

  it('traduz "outras" para "Outras marcas" em getBrandDisplayLabel sem alterar o serviço (E2)', () => {
    const service = new DeviceSpecsService({ fetchImpl: createMockOnlineSources() });
    const brands = service.getSupportedBrands();
    const outrasBrand = brands.find((b) => b.id === 'outras');
    assert.equal(outrasBrand.label, 'Asus / Google / Outras');
    assert.equal(getBrandDisplayLabel(outrasBrand), 'Outras marcas');
    assert.equal(getBrandDisplayLabel(brands.find((b) => b.id === 'samsung')), 'Samsung');
  });

  it('contrato E10: cada exemplo de placeholder por marca resolve OFFLINE com status "found"', async () => {
    const offlineService = new DeviceSpecsService({
      fetchImpl: async () => {
        throw new Error('Rede indisponível (teste offline E10)');
      }
    });

    const brands = offlineService.getSupportedBrands();
    assert.ok(brands.length >= 8);

    for (const brand of brands) {
      const { exampleModel, placeholderText } = getBrandPlaceholderExample(brand);
      assert.ok(exampleModel.length > 0, `Marca "${brand.id}" deve possuir um exemplo de placeholder`);
      assert.equal(placeholderText, `Ex.: ${exampleModel}`);

      const res = await offlineService.lookupDevice(exampleModel, { brandId: brand.id });
      assert.equal(
        res.status,
        'found',
        `Exemplo "${exampleModel}" da marca "${brand.id}" deve resolver offline com status 'found'`
      );
      assert.ok(res.device, `Dispositivo resolvido para "${exampleModel}" não pode ser nulo`);
    }
  });

  it('Etapa 3 (E3, E11, E13, E15): revela #deviceModelStep, foca input apenas em clique/toque (não em seta de teclado) e limpa estado ao trocar de marca', () => {
    const prevDocument = globalThis.document;

    const makeNode = (tag, id = '', initialClasses = []) => {
      const classes = new Set(initialClasses);
      const attrs = new Map();
      const listeners = new Map();
      let focusCount = 0;

      let _className = initialClasses.join(' ');
      const node = {
        tagName: tag.toUpperCase(),
        id,
        type: '',
        name: '',
        value: '',
        checked: false,
        disabled: false,
        placeholder: '',
        textContent: '',
        dataset: {},
        children: [],
        get className() {
          return _className;
        },
        set className(val) {
          _className = String(val || '');
          classes.clear();
          _className
            .split(/\s+/)
            .filter(Boolean)
            .forEach((c) => classes.add(c));
        },
        get firstChild() {
          return this.children[0] || null;
        },
        get focusCount() {
          return focusCount;
        },
        focus() {
          focusCount += 1;
        },
        classList: {
          add(...items) {
            items.forEach((c) => classes.add(c));
          },
          remove(...items) {
            items.forEach((c) => classes.delete(c));
          },
          toggle(c, force) {
            if (force === undefined) {
              if (classes.has(c)) classes.delete(c);
              else classes.add(c);
            } else if (force) classes.add(c);
            else classes.delete(c);
          },
          contains(c) {
            return classes.has(c);
          }
        },
        setAttribute(k, v) {
          attrs.set(k, String(v));
        },
        getAttribute(k) {
          return attrs.has(k) ? attrs.get(k) : null;
        },
        addEventListener(ev, fn) {
          if (!listeners.has(ev)) listeners.set(ev, []);
          listeners.get(ev).push(fn);
        },
        dispatch(ev, payload = {}) {
          const fns = listeners.get(ev) || [];
          fns.forEach((fn) => fn(payload));
        },
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        removeChild(child) {
          const idx = this.children.indexOf(child);
          if (idx >= 0) this.children.splice(idx, 1);
          return child;
        },
        querySelectorAll(selector) {
          const results = [];
          const visit = (n) => {
            for (const ch of n.children || []) {
              if (
                (selector.includes('.brand-option') && ch.classList.contains('brand-option')) ||
                (selector.includes('.brand-radio') && ch.classList.contains('brand-radio')) ||
                (selector.includes('.chip-btn.is-active') &&
                  ch.classList.contains('chip-btn') &&
                  ch.classList.contains('is-active'))
              ) {
                results.push(ch);
              }
              visit(ch);
            }
          };
          visit(this);
          return results;
        }
      };
      return node;
    };

    try {
      const byId = {
        deviceBrandGrid: makeNode('div', 'deviceBrandGrid'),
        deviceBrandStatus: makeNode('span', 'deviceBrandStatus', ['sr-only']),
        deviceModelStep: makeNode('div', 'deviceModelStep', ['device-step-block', 'hidden']),
        deviceQueryLabel: makeNode('label', 'deviceQueryLabel'),
        deviceQueryInput: makeNode('input', 'deviceQueryInput'),
        deviceSearchBtn: makeNode('button', 'deviceSearchBtn'),
        deviceSuggestionsBox: makeNode('div', 'deviceSuggestionsBox', ['hidden']),
        deviceSuggestionsTitle: makeNode('span', 'deviceSuggestionsTitle'),
        deviceLiveSuggestions: makeNode('div', 'deviceLiveSuggestions'),
        deviceFeedback: makeNode('div', 'deviceFeedback', ['hidden']),
        deviceResultPanel: makeNode('div', 'deviceResultPanel', ['hidden'])
      };

      globalThis.document = {
        getElementById: (id) => byId[id] || null,
        createElement: (tag) => makeNode(tag),
        createTextNode: (t) => ({ textContent: t })
      };

      const service = new DeviceSpecsService({ fetchImpl: createMockOnlineSources() });
      const state = { selectedBrandId: null, selectedDevice: { model: 'Old' }, deviceLookupSeq: 0 };
      const controller = createDevicePanelController({ deviceService: service, state });
      controller.renderBrandCards();

      assert.equal(byId.deviceModelStep.classList.contains('hidden'), true);

      const radios = byId.deviceBrandGrid.querySelectorAll('.brand-radio');
      const labels = byId.deviceBrandGrid.querySelectorAll('.brand-option');
      assert.equal(radios.length, 8);
      assert.equal(labels.length, 8);

      // 1. Navegação por seta no teclado: revela #deviceModelStep e anuncia em #deviceBrandStatus, MAS NÃO foca o input
      const samsungRadio = radios[0];
      samsungRadio.dispatch('keydown', { key: 'ArrowRight' });
      samsungRadio.checked = true;
      samsungRadio.dispatch('change');

      assert.equal(state.selectedBrandId, 'samsung');
      assert.equal(byId.deviceModelStep.classList.contains('hidden'), false);
      assert.equal(byId.deviceQueryInput.focusCount, 0, 'Seta de teclado NÃO pode mover foco para o input');
      assert.match(byId.deviceBrandStatus.textContent, /Samsung/);
      assert.equal(byId.deviceQueryInput.placeholder, 'Ex.: A06');

      // Simula preenchimento de busca, sugestões e resultado na marca Samsung
      byId.deviceQueryInput.value = 'A54';
      byId.deviceQueryInput.dispatch('input');
      assert.equal(byId.deviceSuggestionsBox.classList.contains('hidden'), false);
      byId.deviceResultPanel.classList.remove('hidden');
      byId.deviceResultPanel.appendChild(makeNode('div'));

      // 2. Clique/toque em outra marca (Apple): limpa caixa, sugestões e resultado, e MOVE o foco para o input
      const appleRadio = radios[1];
      const appleLabel = labels[1];
      appleLabel.dispatch('pointerdown');
      appleRadio.checked = true;
      appleRadio.dispatch('change');

      assert.equal(state.selectedBrandId, 'apple');
      assert.equal(byId.deviceQueryInput.focusCount, 1, 'Clique/toque DEVE mover o foco para o input');
      assert.equal(byId.deviceQueryInput.value, '', 'Troca de marca deve limpar o input');
      assert.equal(byId.deviceQueryInput.placeholder, 'Ex.: iPhone 15');
      assert.equal(byId.deviceSuggestionsBox.classList.contains('hidden'), true, 'Troca de marca deve ocultar sugestões');
      assert.equal(byId.deviceLiveSuggestions.children.length, 0, 'Troca de marca deve limpar sugestões');
      assert.equal(byId.deviceResultPanel.classList.contains('hidden'), true, 'Troca de marca deve ocultar resultado anterior');
      assert.equal(byId.deviceResultPanel.children.length, 0, 'Troca de marca deve limpar resultado anterior');
    } finally {
      globalThis.document = prevDocument;
    }
  });
});
