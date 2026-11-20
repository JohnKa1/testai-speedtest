/**
 * Base verificada de especificações de conectividade de smartphones.
 * Regra estrita: campos não divulgados oficialmente pelo fabricante permanecem `null`
 * para serem exibidos como "Informação não disponível", sem estimativas fabricadas.
 */

export const DEVICE_CATALOG_VERSION = '2026-11-19';

export const VERIFIED_DEVICES = Object.freeze([
  {
    id: 'samsung-galaxy-a17-5g-br',
    manufacturer: 'Samsung',
    model: 'Galaxy A17 5G',
    aliases: ['a17', 'a17 5g', 'galaxy a17', 'sm-a176'],
    regionalVariant: 'Brasil / América Latina (Sub-6 GHz)',
    wifi: {
      generation: 'Wi-Fi 5',
      standards: '802.11 a/b/g/n/ac',
      bands: ['2,4 GHz', '5 GHz'],
      supports6Ghz: false,
      channelWidthsMhz: null,
      mimo: '1x1 SISO',
      theoreticalLinkMbps: 433,
      favorableRangeMbps: '180 – 280 Mbps'
    },
    cellular: {
      has4G: true,
      has5G: true,
      generations: ['4G LTE', '5G Sub-6'],
      lteCategory: null,
      carrierAggregation: true,
      bands5G: ['n1', 'n3', 'n5', 'n7', 'n28', 'n40', 'n41', 'n66', 'n78'],
      bands4G: ['B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'B8', 'B12', 'B17', 'B20', 'B28', 'B66'],
      theoreticalDownMbps: null,
      theoreticalUpMbps: null
    },
    source: 'Samsung Brasil — Ficha Técnica Oficial / Homologação Anatel',
    dataVersion: '2026-11'
  },
  {
    id: 'samsung-galaxy-a17-4g-br',
    manufacturer: 'Samsung',
    model: 'Galaxy A17 (4G)',
    aliases: ['a17 4g', 'sm-a175'],
    regionalVariant: 'Brasil / América Latina (4G LTE)',
    wifi: {
      generation: 'Wi-Fi 5',
      standards: '802.11 a/b/g/n/ac',
      bands: ['2,4 GHz', '5 GHz'],
      supports6Ghz: false,
      channelWidthsMhz: null,
      mimo: '1x1 SISO',
      theoreticalLinkMbps: 433,
      favorableRangeMbps: '180 – 280 Mbps'
    },
    cellular: {
      has4G: true,
      has5G: false,
      generations: ['4G LTE'],
      lteCategory: null,
      carrierAggregation: true,
      bands5G: [],
      bands4G: ['B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'B8', 'B12', 'B17', 'B20', 'B28', 'B66'],
      theoreticalDownMbps: null,
      theoreticalUpMbps: null
    },
    source: 'Samsung Brasil — Ficha Técnica Oficial',
    dataVersion: '2026-11'
  },
  {
    id: 'samsung-galaxy-s25-fe-br',
    manufacturer: 'Samsung',
    model: 'Galaxy S25 FE',
    aliases: ['s25 fe', 'galaxy s25 fe', 'sm-s731'],
    regionalVariant: 'Brasil / Global (Sub-6 GHz)',
    wifi: {
      generation: 'Wi-Fi 6E',
      standards: '802.11 a/b/g/n/ac/ax (Tri-Band)',
      bands: ['2,4 GHz', '5 GHz', '6 GHz'],
      supports6Ghz: true,
      channelWidthsMhz: [20, 40, 80, 160],
      mimo: '2x2 MIMO',
      theoreticalLinkMbps: 2400,
      favorableRangeMbps: '750 – 1.350 Mbps'
    },
    cellular: {
      has4G: true,
      has5G: true,
      generations: ['4G LTE', '5G Sub-6 (SA/NSA)'],
      lteCategory: 'LTE Cat.20',
      carrierAggregation: true,
      bands5G: ['n1', 'n2', 'n3', 'n5', 'n7', 'n8', 'n12', 'n20', 'n25', 'n28', 'n38', 'n40', 'n41', 'n66', 'n77', 'n78'],
      bands4G: ['B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'B8', 'B12', 'B13', 'B17', 'B20', 'B26', 'B28', 'B38', 'B40', 'B41', 'B66'],
      theoreticalDownMbps: null,
      theoreticalUpMbps: null
    },
    source: 'Samsung Mobile Press / Especificações Oficiais S25 FE',
    dataVersion: '2026-11'
  },
  {
    id: 'apple-iphone-16-br',
    manufacturer: 'Apple',
    model: 'iPhone 16',
    aliases: ['iphone 16', 'a3287'],
    regionalVariant: 'Brasil / Global (A3287 — 5G Sub-6 GHz)',
    wifi: {
      generation: 'Wi-Fi 7',
      standards: '802.11 be (2x2 MIMO, Tri-Band)',
      bands: ['2,4 GHz', '5 GHz', '6 GHz'],
      supports6Ghz: true,
      channelWidthsMhz: [20, 40, 80, 160],
      mimo: '2x2 MIMO',
      theoreticalLinkMbps: 2880,
      favorableRangeMbps: '850 – 1.500 Mbps'
    },
    cellular: {
      has4G: true,
      has5G: true,
      generations: ['4G Gigabit LTE', '5G Sub-6 (SA/NSA)'],
      lteCategory: 'Gigabit LTE (4x4 MIMO)',
      carrierAggregation: true,
      bands5G: ['n1', 'n2', 'n3', 'n5', 'n7', 'n8', 'n12', 'n20', 'n25', 'n26', 'n28', 'n30', 'n38', 'n40', 'n41', 'n48', 'n53', 'n66', 'n70', 'n75', 'n76', 'n77', 'n78', 'n79'],
      bands4G: ['B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'B8', 'B12', 'B13', 'B17', 'B18', 'B19', 'B20', 'B25', 'B26', 'B28', 'B30', 'B32', 'B34', 'B38', 'B39', 'B40', 'B41', 'B42', 'B48', 'B53', 'B66'],
      theoreticalDownMbps: null,
      theoreticalUpMbps: null
    },
    source: 'Apple Technical Specifications — iPhone 16 (Modelo A3287)',
    dataVersion: '2026-11'
  },
  {
    id: 'motorola-edge-50-br',
    manufacturer: 'Motorola',
    model: 'Edge 50',
    aliases: ['edge 50', 'motorola edge 50', 'xt2407'],
    regionalVariant: 'Brasil / América Latina (XT2407-1)',
    wifi: {
      generation: 'Wi-Fi 6E',
      standards: '802.11 a/b/g/n/ac/ax (Tri-Band)',
      bands: ['2,4 GHz', '5 GHz', '6 GHz'],
      supports6Ghz: true,
      channelWidthsMhz: [20, 40, 80, 160],
      mimo: '2x2 MIMO',
      theoreticalLinkMbps: 2400,
      favorableRangeMbps: '700 – 1.300 Mbps'
    },
    cellular: {
      has4G: true,
      has5G: true,
      generations: ['4G LTE', '5G Sub-6 (SA/NSA)'],
      lteCategory: null,
      carrierAggregation: true,
      bands5G: ['n1', 'n2', 'n3', 'n5', 'n7', 'n26', 'n28', 'n38', 'n40', 'n41', 'n66', 'n77', 'n78'],
      bands4G: ['B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'B8', 'B12', 'B13', 'B17', 'B20', 'B26', 'B28', 'B38', 'B40', 'B41', 'B42', 'B66'],
      theoreticalDownMbps: null,
      theoreticalUpMbps: null
    },
    source: 'Motorola Brasil — Especificações Oficiais Edge 50',
    dataVersion: '2026-11'
  },
  {
    id: 'xiaomi-redmi-note-14-5g-global',
    manufacturer: 'Xiaomi',
    model: 'Redmi Note 14 5G',
    aliases: ['redmi note 14', 'redmi note 14 5g', 'note 14 5g'],
    regionalVariant: 'Global / Brasil (Sub-6 GHz)',
    wifi: {
      generation: 'Wi-Fi 5',
      standards: '802.11 a/b/g/n/ac',
      bands: ['2,4 GHz', '5 GHz'],
      supports6Ghz: false,
      channelWidthsMhz: [20, 40, 80],
      mimo: '1x1 SISO',
      theoreticalLinkMbps: 433,
      favorableRangeMbps: '180 – 280 Mbps'
    },
    cellular: {
      has4G: true,
      has5G: true,
      generations: ['4G LTE', '5G Sub-6 (SA/NSA)'],
      lteCategory: null,
      carrierAggregation: true,
      bands5G: ['n1', 'n3', 'n5', 'n7', 'n8', 'n20', 'n28', 'n38', 'n40', 'n41', 'n66', 'n77', 'n78'],
      bands4G: ['B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'B8', 'B12', 'B13', 'B17', 'B20', 'B26', 'B28', 'B38', 'B40', 'B41', 'B66'],
      theoreticalDownMbps: null,
      theoreticalUpMbps: null
    },
    source: 'Xiaomi Global — Redmi Note 14 5G Specifications',
    dataVersion: '2026-11'
  },
  {
    id: 'xiaomi-redmi-note-14-4g-global',
    manufacturer: 'Xiaomi',
    model: 'Redmi Note 14 (4G)',
    aliases: ['redmi note 14 4g', 'note 14 4g'],
    regionalVariant: 'Global / Brasil (4G LTE)',
    wifi: {
      generation: 'Wi-Fi 5',
      standards: '802.11 a/b/g/n/ac',
      bands: ['2,4 GHz', '5 GHz'],
      supports6Ghz: false,
      channelWidthsMhz: [20, 40, 80],
      mimo: '1x1 SISO',
      theoreticalLinkMbps: 433,
      favorableRangeMbps: '180 – 280 Mbps'
    },
    cellular: {
      has4G: true,
      has5G: false,
      generations: ['4G LTE'],
      lteCategory: null,
      carrierAggregation: true,
      bands5G: [],
      bands4G: ['B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'B8', 'B20', 'B28', 'B38', 'B40', 'B41', 'B66'],
      theoreticalDownMbps: null,
      theoreticalUpMbps: null
    },
    source: 'Xiaomi Global — Redmi Note 14 Specifications',
    dataVersion: '2026-11'
  },
  {
    id: 'samsung-galaxy-s25-ultra-br',
    manufacturer: 'Samsung',
    model: 'Galaxy S25 Ultra',
    aliases: ['s25 ultra', 'galaxy s25 ultra', 'sm-s938'],
    regionalVariant: 'Brasil / Global (Sub-6 GHz)',
    wifi: {
      generation: 'Wi-Fi 7',
      standards: '802.11 be (Tri-Band)',
      bands: ['2,4 GHz', '5 GHz', '6 GHz'],
      supports6Ghz: true,
      channelWidthsMhz: [20, 40, 80, 160, 320],
      mimo: '2x2 MIMO',
      theoreticalLinkMbps: 5760,
      favorableRangeMbps: '1.100 – 2.200 Mbps'
    },
    cellular: {
      has4G: true,
      has5G: true,
      generations: ['4G LTE', '5G Sub-6 (SA/NSA)'],
      lteCategory: 'LTE Cat.20',
      carrierAggregation: true,
      bands5G: ['n1', 'n2', 'n3', 'n5', 'n7', 'n8', 'n12', 'n20', 'n25', 'n28', 'n38', 'n40', 'n41', 'n66', 'n77', 'n78'],
      bands4G: ['B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'B8', 'B12', 'B13', 'B17', 'B20', 'B26', 'B28', 'B38', 'B40', 'B41', 'B66'],
      theoreticalDownMbps: null,
      theoreticalUpMbps: null
    },
    source: 'Samsung Brasil — Ficha Técnica Oficial Galaxy S25 Ultra',
    dataVersion: '2026-11'
  },
  {
    id: 'samsung-galaxy-a55-5g-br',
    manufacturer: 'Samsung',
    model: 'Galaxy A55 5G',
    aliases: ['a55', 'a55 5g', 'galaxy a55', 'sm-a556'],
    regionalVariant: 'Brasil / América Latina (SM-A556E)',
    wifi: {
      generation: 'Wi-Fi 6',
      standards: '802.11 a/b/g/n/ac/ax (Dual-Band)',
      bands: ['2,4 GHz', '5 GHz'],
      supports6Ghz: false,
      channelWidthsMhz: [20, 40, 80],
      mimo: '2x2 MIMO',
      theoreticalLinkMbps: 1200,
      favorableRangeMbps: '450 – 750 Mbps'
    },
    cellular: {
      has4G: true,
      has5G: true,
      generations: ['4G LTE', '5G Sub-6 (SA/NSA)'],
      lteCategory: 'LTE Cat.18',
      carrierAggregation: true,
      bands5G: ['n1', 'n3', 'n5', 'n7', 'n8', 'n20', 'n28', 'n38', 'n40', 'n41', 'n66', 'n77', 'n78'],
      bands4G: ['B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'B8', 'B12', 'B17', 'B20', 'B26', 'B28', 'B38', 'B40', 'B41', 'B66'],
      theoreticalDownMbps: null,
      theoreticalUpMbps: null
    },
    source: 'Samsung Brasil — Ficha Técnica Oficial Galaxy A55 5G',
    dataVersion: '2026-11'
  },
  {
    id: 'apple-iphone-15-br',
    manufacturer: 'Apple',
    model: 'iPhone 15',
    aliases: ['iphone 15', 'a3090'],
    regionalVariant: 'Brasil / Global (A3090 — 5G Sub-6 GHz)',
    wifi: {
      generation: 'Wi-Fi 6',
      standards: '802.11 ax (2x2 MIMO, Dual-Band)',
      bands: ['2,4 GHz', '5 GHz'],
      supports6Ghz: false,
      channelWidthsMhz: [20, 40, 80],
      mimo: '2x2 MIMO',
      theoreticalLinkMbps: 1200,
      favorableRangeMbps: '480 – 780 Mbps'
    },
    cellular: {
      has4G: true,
      has5G: true,
      generations: ['4G Gigabit LTE', '5G Sub-6 (SA/NSA)'],
      lteCategory: 'Gigabit LTE',
      carrierAggregation: true,
      bands5G: ['n1', 'n2', 'n3', 'n5', 'n7', 'n8', 'n12', 'n20', 'n25', 'n26', 'n28', 'n30', 'n38', 'n40', 'n41', 'n48', 'n53', 'n66', 'n70', 'n77', 'n78', 'n79'],
      bands4G: ['B1', 'B2', 'B3', 'B4', 'B5', 'B7', 'B8', 'B12', 'B13', 'B17', 'B20', 'B25', 'B26', 'B28', 'B30', 'B32', 'B38', 'B40', 'B41', 'B42', 'B48', 'B66'],
      theoreticalDownMbps: null,
      theoreticalUpMbps: null
    },
    source: 'Apple Technical Specifications — iPhone 15 (Modelo A3090)',
    dataVersion: '2026-11'
  }
]);

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function searchDevicesCatalog(query, limit = 6) {
  const clean = normalizeText(query);
  if (!clean) {
    return VERIFIED_DEVICES.slice(0, limit);
  }

  const tokens = clean.split(' ').filter(Boolean);

  const scored = VERIFIED_DEVICES.map((device) => {
    const haystack = normalizeText(
      [
        device.manufacturer,
        device.model,
        device.regionalVariant,
        ...(device.aliases || [])
      ].join(' ')
    );

    const exactFull =
      normalizeText(`${device.manufacturer} ${device.model}`) === clean ||
      normalizeText(device.model) === clean ||
      (device.aliases || []).some((a) => normalizeText(a) === clean);

    const allTokensMatch = tokens.every((tk) => haystack.includes(tk));
    if (!exactFull && !allTokensMatch) {
      return null;
    }

    let score = exactFull ? 100 : 50;
    if (haystack.startsWith(clean)) score += 20;
    score -= Math.abs(normalizeText(device.model).length - clean.length) * 0.2;

    return { device, score };
  })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((item) => item.device);
}