/**
 * Serviço de consulta ONLINE de especificações e identificação de smartphones (100% client-side).
 * Camada 1: MediaWiki / Wikipedia Online EN e PT (Infobox com desembrulhamento recursivo + seção técnica do artigo).
 * Camada 2: Google Play Certified Devices Registry via jsDelivr CDN (30.000+ modelos regionais/antigos).
 * A classificação (Básico / Médio / Alto Desempenho) e as médias por banda Wi-Fi são derivadas
 * deterministicamente a partir do hardware, geração Wi-Fi e linha comercial do aparelho.
 */

let googlePlayCatalogPromise = null;

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const REQUEST_TIMEOUT_MS = 7000;
const GOOGLE_PLAY_DEVICES_CDN = 'https://cdn.jsdelivr.net/gh/bsthen/device-models/devices.json';

const WIKI_ENDPOINTS = [
  { url: 'https://en.wikipedia.org/w/api.php', label: 'Wikipedia Online Specs (EN)' },
  { url: 'https://pt.wikipedia.org/w/api.php', label: 'Wikipedia Online Specs (PT)' }
];

export function sanitizeDeviceQuery(raw) {
  return String(raw ?? '')
    .replace(/&nbsp;|&#0*160;|&#x0*a0;|\u00a0/gi, ' ')
    .replace(/[<>"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeTokens(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/(\d|\bpro|\bram|\bedge|\brazer?)\s*\+/gi, '$1 plus ')
    .replace(/\b(flip|fold|razr|note|edge|pixel|iphone|ipad|zenfone|magic|reno|hot|smart|nord)(\d)/gi, '$1 $2')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

const BRAND_TOKENS = new Set([
  'samsung',
  'galaxy',
  'apple',
  'motorola',
  'moto',
  'xiaomi',
  'mi',
  'redmi',
  'poco',
  'realme',
  'asus',
  'google',
  'oneplus',
  'nokia',
  'lg',
  'huawei',
  'honor',
  'vivo',
  'jovi',
  'oppo',
  'infinix',
  'tecno',
  'positivo',
  'multilaser',
  'philco',
  'lenovo',
  'sony',
  'nothing',
  'cmf',
  'zekr'
]);

const ACCESSORY_NOISE_TOKENS = new Set([
  '5g',
  '4g',
  'lte',
  '3g',
  'duos',
  'dual',
  'sim',
  'esim',
  'nfc',
  'ram',
  'rom',
  'gb',
  'tb',
  '16gb',
  '32gb',
  '64gb',
  '128gb',
  '256gb',
  '512gb',
  '1tb',
  '2gb',
  '3gb',
  '4gb',
  '6gb',
  '8gb',
  '12gb',
  '24gb',
  'celular',
  'smartphone',
  'telefone',
  'phone',
  'mobile',
  'aparelho',
  'global',
  'nacional',
  'original'
]);

const SUBFAMILY_TOKENS = new Set([
  'note',
  'fold',
  'flip',
  'razr',
  'tab',
  'watch',
  'ipad',
  'rog',
  'zenfone',
  'xperia',
  'magic',
  'reno',
  'find',
  'nord',
  'narzo',
  'pura',
  'mate',
  'velvet'
]);

// Edições que mudam completamente a linha do produto e exigem correspondência estrita
const STRICT_EDITION_TOKENS = new Set([
  'fe',
  'lite',
  'core',
  'pocket',
  'young',
  'go',
  'se'
]);

// Variantes que na Wikipedia frequentemente ficam agrupadas dentro do artigo do modelo base
const GROUPABLE_VARIANT_TOKENS = new Set([
  'pro',
  'max',
  'ultra',
  'plus',
  'mini',
  'air',
  'neo',
  'fusion',
  'play',
  'power',
  'stylus',
  'prime',
  'gt',
  'xl',
  's',
  't',
  'x'
]);

function extractModelCodeTokens(tokens) {
  return tokens.filter((t) => {
    if (BRAND_TOKENS.has(t) || ACCESSORY_NOISE_TOKENS.has(t)) return false;
    if (SUBFAMILY_TOKENS.has(t) || STRICT_EDITION_TOKENS.has(t) || GROUPABLE_VARIANT_TOKENS.has(t)) {
      return false;
    }
    if (/^(?:199\d|20[0-3]\d)$/.test(t)) return false;
    if (/^(?:1st|2nd|3rd|[4-9]th|1\dth|generation|geracao|ger)$/.test(t)) return false;
    return /\d/.test(t) || /^(?:xr|xs)$/i.test(t);
  });
}

/**
 * Desembrulha templates aninhados {{...}} de dentro para fora sem descartar listas nem datas.
 */
function unwrapInnerTemplates(text) {
  let current = String(text || '');
  let safety = 0;

  while (/\{\{[^{}]+\}\}/.test(current) && safety < 14) {
    safety++;
    current = current.replace(/\{\{([^{}]+)\}\}/g, (_, body) => {
      const parts = body.split('|').map((p) => p.trim());
      const tplName = (parts[0] || '').toLowerCase();

      if (
        /^(?:ubl|unbulleted list|flatlist|hlist|plainlist|vunblist|cslist|comma separated entries)$/.test(
          tplName
        )
      ) {
        return parts
          .slice(1)
          .filter((p) => p && !/^(?:class|style|list_style|item_style|indent)\s*=/.test(p))
          .flatMap((p) => p.split(/\r?\n/).map((line) => line.replace(/^\*+\s*/, '').trim()))
          .filter(Boolean)
          .join(', ');
      }

      if (/^(?:start date|start date and age|release date|end date|dts)$/i.test(tplName)) {
        const nums = parts
          .slice(1)
          .filter((p) => /^\d{1,4}$/.test(p))
          .map((n) => n.padStart(2, '0'));
        if (nums.length >= 3) return `${nums[0]}-${nums[1]}-${nums[2]}`;
        if (nums.length === 2) return `${nums[0]}-${nums[1]}`;
        if (nums.length === 1) return nums[0];
        return '';
      }

      if (/^(?:nowrap|abbr|lang|small|big|strong|b|i)$/.test(tplName)) {
        return parts[1] || '';
      }

      if (/^(?:cvt|convert)$/.test(tplName) && parts[1] && parts[2]) {
        return `${parts[1]} ${parts[2]}`;
      }

      return ' ';
    });
  }

  return current;
}

function cleanWikiMarkup(raw) {
  const withoutComments = String(raw || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, ' ')
    .replace(/<ref[^/]*\/>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ', ');

  const unwrapped = unwrapInnerTemplates(withoutComments);

  return unwrapped
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[\[(?:[^|\]]+\|)?([^\]]+)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/&nbsp;|&#0*160;|&#x0*a0;|\u00a0/gi, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(?:,\s*){2,}/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/^[,;:\s]+|[,;:\s]+$/g, '')
    .trim();
}

function extractInfoboxField(wikitext, fieldNames) {
  const namesPattern = fieldNames.join('|');
  const startRegex = new RegExp(`\\|\\s*(?:${namesPattern})\\s*=`, 'i');
  const match = startRegex.exec(wikitext);
  if (!match) return '';

  let i = match.index + match[0].length;
  let braceDepth = 0;
  let bracketDepth = 0;
  let out = '';

  while (i < wikitext.length) {
    const two = wikitext.slice(i, i + 2);
    if (two === '{{') {
      braceDepth++;
      out += two;
      i += 2;
      continue;
    }
    if (two === '}}') {
      if (braceDepth === 0) break;
      braceDepth = Math.max(0, braceDepth - 1);
      out += two;
      i += 2;
      continue;
    }
    if (two === '[[') {
      bracketDepth++;
      out += two;
      i += 2;
      continue;
    }
    if (two === ']]') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      out += two;
      i += 2;
      continue;
    }
    if (wikitext[i] === '|' && braceDepth === 0 && bracketDepth === 0) {
      break;
    }
    out += wikitext[i];
    i++;
  }

  return cleanWikiMarkup(out);
}

/**
 * Extrai trechos técnicos do corpo do artigo caso o Infobox não tenha preenchido Wi-Fi/Redes.
 */
function extractArticleFallbackSpecs(wikitext) {
  const cleanedBody = cleanWikiMarkup(wikitext);
  const wifiSnippets = cleanedBody.match(
    /(?:wi-?fi\s*(?:4|5|6e|6|7)?\s*\(?802\.11[^.;)\n]*\)?|802\.11\s*[a-z0-9/]+(?:,\s*(?:dual-?band|tri-?band|2\.4\s*ghz|5\s*ghz|6\s*ghz))?)/gi
  );
  const netSnippets = cleanedBody.match(
    /\b(?:5g(?:\s*(?:sub-?6|mmwave|sa|nsa))?|4g\s*lte|lte(?:\s*cat\.?\s*\d+)?|3g|hspa|gsm)\b/gi
  );

  return {
    wifiText: wifiSnippets ? [...new Set(wifiSnippets)].slice(0, 3).join(', ') : '',
    netText: netSnippets ? [...new Set(netSnippets)].slice(0, 6).join(', ') : ''
  };
}

function parseWifiSpecs(connectivityText) {
  const txt = String(connectivityText || '');
  let generation = null;

  if (/802\.11\s*[a-z0-9/]*(?:be|\/7)\b|wi-?fi\s*7\b/i.test(txt)) {
    generation = 'Wi-Fi 7';
  } else if (/802\.11\s*[a-z0-9/]*\/6e\b|wi-?fi\s*6e\b|6\s*ghz/i.test(txt)) {
    generation = 'Wi-Fi 6E';
  } else if (/802\.11\s*[a-z0-9/]*(?:ax|\/6)\b|wi-?fi\s*6\b/i.test(txt)) {
    generation = 'Wi-Fi 6';
  } else if (/802\.11\s*[a-z0-9/]*ac\b|wi-?fi\s*5\b/i.test(txt)) {
    generation = 'Wi-Fi 5';
  } else if (/802\.11\s*[a-z0-9/]*n\b|wi-?fi\s*4\b/i.test(txt)) {
    generation = 'Wi-Fi 4';
  } else if (/802\.11\s*[a-z0-9/]*[bg]\b/i.test(txt)) {
    generation = 'Wi-Fi 3 (802.11b/g)';
  }

  const bands = [];
  const supports6Ghz =
    generation === 'Wi-Fi 6E' ||
    generation === 'Wi-Fi 7' ||
    /tri-?band|6\s*ghz/i.test(txt);

  if (txt) {
    if (/2\.4\s*ghz|dual-?band|tri-?band|802\.11|wi-?fi/i.test(txt)) {
      bands.push('2,4 GHz');
    }
    if (
      /5\s*ghz|dual-?band|tri-?band|802\.11\s*[a-z0-9/]*(?:a|ac|ax|be|\/6e?|\/7)\b/i.test(txt) ||
      ['Wi-Fi 5', 'Wi-Fi 6', 'Wi-Fi 6E', 'Wi-Fi 7'].includes(generation)
    ) {
      bands.push('5 GHz');
    }
    if (supports6Ghz) {
      bands.push('6 GHz');
    }
  }

  const stdMatch = txt.match(/802\.11\s*[a-z0-9/]+/i);
  const standards = stdMatch ? stdMatch[0] : generation || 'Informação não disponível';

  return {
    generation: generation || 'Informação não disponível',
    standards,
    bands: [...new Set(bands)],
    supports6Ghz,
    channelWidthsMhz: null,
    mimo: null,
    theoreticalLinkMbps: null,
    favorableRangeMbps: null
  };
}

function parseCellularSpecs(networksText, fullTitle) {
  const combined = `${networksText || ''} ${fullTitle || ''}`;
  const has5G = /\b5g\b|\bnr\b/i.test(combined);
  const has4G = /\b4g\b|\blte\b/i.test(combined);
  const has3G = /\b3g\b|\bumts\b|\bhspa\b/i.test(combined);

  const generations = [];
  if (has3G && !has4G && !has5G) generations.push('3G');
  if (has4G) generations.push('4G LTE');
  if (has5G) generations.push('5G');

  const lteCatMatch = combined.match(/lte\s*cat\.?\s*(\d+)/i);
  const lteCategory = lteCatMatch ? `LTE Cat.${lteCatMatch[1]}` : null;

  return {
    has4G,
    has5G,
    generations,
    lteCategory,
    carrierAggregation: null,
    bands5G: [],
    bands4G: [],
    theoreticalDownMbps: null,
    theoreticalUpMbps: null
  };
}

function normalizeDevicePayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const manufacturer = sanitizeDeviceQuery(raw.manufacturer);
  const model = sanitizeDeviceQuery(raw.model);
  if (!manufacturer && !model) return null;

  const hwRaw = raw.hardware && typeof raw.hardware === 'object' ? raw.hardware : {};
  const wifiRaw = raw.wifi && typeof raw.wifi === 'object' ? raw.wifi : {};
  const cellRaw = raw.cellular && typeof raw.cellular === 'object' ? raw.cellular : {};

  return {
    id: sanitizeDeviceQuery(raw.id || `${manufacturer}-${model}`).toLowerCase().replace(/\s+/g, '-'),
    manufacturer: manufacturer || 'Fabricante não especificado',
    model: model || 'Modelo consultado',
    regionalVariant: sanitizeDeviceQuery(raw.regionalVariant) || 'Especificação Internacional / Comercial',
    hardware: {
      chipset: sanitizeDeviceQuery(hwRaw.chipset) || null,
      ram: sanitizeDeviceQuery(hwRaw.ram) || null
    },
    wifi: {
      generation: sanitizeDeviceQuery(wifiRaw.generation) || 'Informação não disponível',
      standards: sanitizeDeviceQuery(wifiRaw.standards) || 'Informação não disponível',
      bands: Array.isArray(wifiRaw.bands)
        ? wifiRaw.bands.map((b) => sanitizeDeviceQuery(b)).filter(Boolean)
        : [],
      supports6Ghz: Boolean(wifiRaw.supports6Ghz),
      channelWidthsMhz: Array.isArray(wifiRaw.channelWidthsMhz)
        ? wifiRaw.channelWidthsMhz.filter((n) => Number.isFinite(Number(n))).map(Number)
        : null,
      mimo: sanitizeDeviceQuery(wifiRaw.mimo) || null,
      theoreticalLinkMbps:
        Number.isFinite(Number(wifiRaw.theoreticalLinkMbps)) && Number(wifiRaw.theoreticalLinkMbps) > 0
          ? Number(wifiRaw.theoreticalLinkMbps)
          : null,
      favorableRangeMbps: sanitizeDeviceQuery(wifiRaw.favorableRangeMbps) || null
    },
    cellular: {
      has4G: Boolean(cellRaw.has4G),
      has5G: Boolean(cellRaw.has5G),
      generations: Array.isArray(cellRaw.generations)
        ? cellRaw.generations.map((g) => sanitizeDeviceQuery(g)).filter(Boolean)
        : [],
      lteCategory: sanitizeDeviceQuery(cellRaw.lteCategory) || null,
      carrierAggregation:
        typeof cellRaw.carrierAggregation === 'boolean' ? cellRaw.carrierAggregation : null,
      bands5G: Array.isArray(cellRaw.bands5G)
        ? cellRaw.bands5G.map((b) => sanitizeDeviceQuery(b)).filter(Boolean)
        : [],
      bands4G: Array.isArray(cellRaw.bands4G)
        ? cellRaw.bands4G.map((b) => sanitizeDeviceQuery(b)).filter(Boolean)
        : [],
      theoreticalDownMbps:
        Number.isFinite(Number(cellRaw.theoreticalDownMbps)) && Number(cellRaw.theoreticalDownMbps) > 0
          ? Number(cellRaw.theoreticalDownMbps)
          : null,
      theoreticalUpMbps:
        Number.isFinite(Number(cellRaw.theoreticalUpMbps)) && Number(cellRaw.theoreticalUpMbps) > 0
          ? Number(cellRaw.theoreticalUpMbps)
          : null
    },
    source: sanitizeDeviceQuery(raw.source) || 'Consulta Online',
    dataVersion: sanitizeDeviceQuery(raw.dataVersion) || new Date().toISOString().slice(0, 10)
  };
}

function scoreCandidateTitle(title, queryTokens) {
  const rawTitle = String(title || '').trim();
  if (!rawTitle) return -1;

  // Bloqueia listas e comparativos genéricos
  if (/^(?:list of|lista de|comparison of|history of|comparação|história)\b/i.test(rawTitle)) {
    return -1;
  }

  // Remove sufixos entre parênteses como "(2024)", "(3rd generation)" para não gerar falso código extra
  const baseTitleWithoutParens = rawTitle.replace(/\([^)]*\)/g, ' ').trim() || rawTitle;
  const titleTokens = normalizeTokens(rawTitle);
  const baseTitleTokens = normalizeTokens(baseTitleWithoutParens);
  if (titleTokens.length === 0) return -1;

  const queryModelCodes = extractModelCodeTokens(queryTokens);
  const titleModelCodes = extractModelCodeTokens(baseTitleTokens);

  // Bloqueia páginas genéricas de série que não possuem número do modelo (ex.: "Samsung Galaxy A series")
  if (
    /\b(?:series|série|serie|family|família|familia|lineup)\b/i.test(rawTitle) &&
    titleModelCodes.length === 0
  ) {
    return -1;
  }

  // 1. Exige casamento exato de TODOS os códigos/números de modelo pesquisados (ex.: a15 != a10, g84 != g8)
  if (queryModelCodes.length > 0) {
    for (const code of queryModelCodes) {
      if (!titleTokens.includes(code)) {
        return -1;
      }
    }
    // Rejeita títulos que contenham códigos numéricos extras de outros modelos fora de parênteses
    if (titleModelCodes.some((tc) => !queryModelCodes.includes(tc))) {
      return -1;
    }
  } else if (titleModelCodes.length > 0) {
    // Se a busca não especificou número, rejeita artigos de um número arbitrário (ex.: "Moto G" -> "Moto G5")
    return -1;
  }

  // 2. Exige equivalência estrita de subfamília (ex.: "Redmi 13" != "Redmi Note 13", "Galaxy S24" != "Galaxy Tab S24")
  for (const sub of SUBFAMILY_TOKENS) {
    if (queryTokens.includes(sub) !== titleTokens.includes(sub)) {
      return -1;
    }
  }

  // 3. Exige equivalência estrita para edições distintas (ex.: "Galaxy S24" != "Galaxy S24 FE")
  for (const ed of STRICT_EDITION_TOKENS) {
    if (queryTokens.includes(ed) !== titleTokens.includes(ed)) {
      return -1;
    }
  }

  // 4. Não permite que busca pelo modelo base retorne variante Pro/Ultra/Max/Plus/Mini/Power não solicitada no título
  for (const variant of GROUPABLE_VARIANT_TOKENS) {
    if (!queryTokens.includes(variant) && baseTitleTokens.includes(variant)) {
      return -1;
    }
  }

  let matched = 0;
  for (const qt of queryTokens) {
    if (titleTokens.includes(qt)) {
      matched += 3;
    } else if (
      BRAND_TOKENS.has(qt) &&
      titleTokens.some((tt) => tt.startsWith(qt) || qt.startsWith(tt))
    ) {
      matched += 1;
    }
  }

  // Bônus quando variantes solicitadas (Pro, Max, Ultra, Plus, Mini, Power, Fusion, Neo) batem diretamente no título
  for (const variant of GROUPABLE_VARIANT_TOKENS) {
    if (queryTokens.includes(variant) && titleTokens.includes(variant)) {
      matched += 4;
    }
  }

  return matched - titleTokens.length * 0.05;
}

function cleanReleasedLabel(releasedRaw) {
  const cleaned = String(releasedRaw || '')
    // Remove etiquetas órfãs sem data (ex.: "4G:, 5G:, 5G UW:")
    .replace(/\b[A-Za-z0-9\s-]{1,12}:\s*(?=,|$)/g, '')
    .replace(/(?:,\s*){2,}/g, ', ')
    .replace(/^[,;:\s]+|[,;:\s]+$/g, '')
    .trim();
  return cleaned;
}

function buildWifiAndCellPayload({ manufacturer, model, wifiGen, has5G, chipset = null }) {
  const supports6Ghz = wifiGen === 'Wi-Fi 6E' || wifiGen === 'Wi-Fi 7';
  const supports5Ghz =
    supports6Ghz || wifiGen === 'Wi-Fi 5' || wifiGen === 'Wi-Fi 6';
  const bands = supports6Ghz
    ? ['2,4 GHz', '5 GHz', '6 GHz']
    : supports5Ghz
      ? ['2,4 GHz', '5 GHz']
      : ['2,4 GHz'];
  const standards =
    wifiGen === 'Wi-Fi 7'
      ? '802.11 a/b/g/n/ac/ax/be'
      : wifiGen === 'Wi-Fi 6' || wifiGen === 'Wi-Fi 6E'
        ? '802.11 a/b/g/n/ac/ax'
        : wifiGen === 'Wi-Fi 5'
          ? '802.11 a/b/g/n/ac'
          : '802.11 b/g/n';

  return {
    manufacturer,
    model,
    hardware: { chipset, ram: null },
    wifi: { generation: wifiGen, standards, bands, supports6Ghz },
    cellular: {
      has4G: true,
      has5G: Boolean(has5G),
      generations: has5G ? ['4G LTE', '5G'] : ['4G LTE']
    }
  };
}

export const SUPPORTED_DEVICE_BRANDS = [
  {
    id: 'samsung',
    label: 'Samsung',
    tagline: 'Galaxy A, S, M, Z, Note, J',
    placeholder: 'Ex.: A06, A55, S24 Ultra, Z Flip 6, A15...',
    defaultPrefix: 'Samsung Galaxy'
  },
  {
    id: 'apple',
    label: 'Apple',
    tagline: 'iPhone 6s ao 17 Pro Max, SE, iPad',
    placeholder: 'Ex.: iPhone 15, 16 Pro Max, 13, 11, XR...',
    defaultPrefix: 'Apple iPhone'
  },
  {
    id: 'motorola',
    label: 'Motorola',
    tagline: 'Moto G, Moto E, Edge, Razr',
    placeholder: 'Ex.: G84, G54, E22, Edge 50 Pro, Razr 50...',
    defaultPrefix: 'Motorola'
  },
  {
    id: 'xiaomi',
    label: 'Xiaomi / Redmi',
    tagline: 'Redmi Note, Redmi A/C, Xiaomi',
    placeholder: 'Ex.: Note 13, 13C, 14C, Note 12 Pro, Xiaomi 14...',
    defaultPrefix: 'Xiaomi'
  },
  {
    id: 'poco',
    label: 'POCO',
    tagline: 'Poco X, Poco F, Poco M, Poco C',
    placeholder: 'Ex.: X6 Pro, F6, M6 Pro, C65, X5 Pro...',
    defaultPrefix: 'POCO'
  },
  {
    id: 'realme',
    label: 'Realme',
    tagline: 'Realme C, Série Numerada, Note, GT',
    placeholder: 'Ex.: C67, C55, 12 Pro+, 11, Note 50, GT 6...',
    defaultPrefix: 'Realme'
  },
  {
    id: 'infinix',
    label: 'Infinix',
    tagline: 'Hot, Note, Smart, GT, Zero',
    placeholder: 'Ex.: Hot 40 Pro, Note 30, Smart 8, GT 20 Pro...',
    defaultPrefix: 'Infinix'
  },
  {
    id: 'outras',
    label: 'Asus / Google / Outras',
    tagline: 'Zenfone, ROG, Pixel, OnePlus, Honor, Oppo, Positivo',
    placeholder: 'Ex.: Zenfone 10, Pixel 9 Pro, OnePlus 12, Positivo Twist...',
    defaultPrefix: ''
  }
];

/**
 * Verifica se uma consulta ou data de lançamento refere-se a aparelho anterior a 2015 (fora da janela 2015–2026).
 */
export function isPre2015DeviceQuery(rawQuery) {
  const tokens = normalizeTokens(rawQuery);
  if (tokens.length === 0) return false;
  const joined = tokens.join(' ');

  // Se houver ano explícito entre 2000 e 2014
  if (/\b(?:200\d|201[0-4])\b/.test(joined)) return true;

  // Apple pré-2015: iPhone 2G, 3G, 3GS, 4, 4s, 5, 5c, 5s, 6, 6 Plus (6s é de 2015)
  if (
    tokens.includes('iphone') &&
    /\biphone\s+(?:2g|3gs?|4s?|5[cs]?|6(?:\s+plus)?)\b/.test(joined) &&
    !tokens.includes('6s')
  ) {
    return true;
  }

  // Samsung pré-2015: Galaxy S / S2 / S3 / S4 / S5, Galaxy Note 1 / 2 / 3 / 4
  if (
    (tokens.includes('galaxy') || tokens.includes('samsung')) &&
    (/\b(?:s[1-5]|s\s+ii|s\s+iii|s\s+iv)\b/.test(joined) || /\bnote\s+[1-4]\b/.test(joined))
  ) {
    return true;
  }

  // Motorola pré-2015: Moto G1, Moto G2, Moto E1, Moto X1, Moto X2
  if (
    (tokens.includes('moto') || tokens.includes('motorola')) &&
    /\b(?:g[12]|e1|x[12])\b/.test(joined) &&
    !/\b(?:g1\d|g2\d|g100|g200|e1\d)\b/.test(joined)
  ) {
    return true;
  }

  return false;
}

function isPre2015ReleaseDate(releasedText) {
  const years = String(releasedText || '').match(/\b(199\d|20[0-2]\d)\b/g);
  if (!years || years.length === 0) return false;
  const numericYears = years.map((y) => parseInt(y, 10));
  return numericYears.every((y) => y < 2015);
}

/**
 * Escopa a consulta bruta do usuário à marca selecionada na Etapa 1.
 */
export function scopeQueryToBrand(rawQuery, brandId) {
  const cleaned = sanitizeDeviceQuery(rawQuery);
  if (!cleaned) return '';
  if (!brandId || brandId === 'outras') return cleaned;

  const lower = cleaned.toLowerCase();
  // Preserva SKUs intactos
  if (/^(?:sm-[a-z0-9-]+|xt\d{3,}[a-z0-9-]*|rmx\d{3,}[a-z0-9-]*|cph\d{3,}[a-z0-9-]*)$/i.test(cleaned)) {
    return cleaned;
  }

  if (brandId === 'samsung') {
    if (/\b(?:samsung|galaxy)\b/i.test(lower)) return cleaned;
    return `Samsung Galaxy ${cleaned}`;
  }
  if (brandId === 'apple') {
    if (/\b(?:iphone|ipad|apple)\b/i.test(lower)) return cleaned;
    return `iPhone ${cleaned}`;
  }
  if (brandId === 'motorola') {
    if (/\b(?:motorola|moto|edge|razr|one)\b/i.test(lower)) return cleaned;
    return `Moto ${cleaned}`;
  }
  if (brandId === 'xiaomi') {
    if (/\b(?:xiaomi|redmi|mi|poco)\b/i.test(lower)) return cleaned;
    if (/^\d{1,2}(?:\s+(?:t|pro|ultra|lite))*\b/i.test(cleaned) && !/[ac]\b/i.test(cleaned) && !/\bnote\b/i.test(lower)) {
      const n = parseInt(cleaned, 10);
      if (n >= 11 && n <= 15) return `Xiaomi ${cleaned}`;
    }
    return `Redmi ${cleaned}`;
  }
  if (brandId === 'poco') {
    if (/\bpoco\b/i.test(lower)) return cleaned;
    return `Poco ${cleaned}`;
  }
  if (brandId === 'realme') {
    if (/\brealme\b/i.test(lower)) return cleaned;
    return `Realme ${cleaned}`;
  }
  if (brandId === 'infinix') {
    if (/\binfinix\b/i.test(lower)) return cleaned;
    return `Infinix ${cleaned}`;
  }
  return cleaned;
}

function buildBrandCatalog2015To2026() {
  /** @type {Record<string, Array<{ brandId: string, manufacturer: string, model: string, fullLabel: string, wifiGen: string, has5G: boolean, searchTokens: string[], compactKey: string, priority: number }>>} */
  const byBrand = {
    samsung: [],
    apple: [],
    motorola: [],
    xiaomi: [],
    poco: [],
    realme: [],
    infinix: [],
    outras: []
  };

  const registerModel = (brandId, querySeed, priority = 50) => {
    const spec = resolveKnownFamilySpecs(querySeed);
    if (!spec) return;
    const list = byBrand[brandId];
    if (!list) return;
    if (list.some((item) => item.model.toLowerCase() === spec.model.toLowerCase())) return;

    const fullLabel = `${spec.manufacturer} ${spec.model}`;
    const searchTokens = normalizeTokens(`${spec.manufacturer} ${spec.model}`);
    const compactKey = searchTokens.join('');
    list.push({
      brandId,
      manufacturer: spec.manufacturer,
      model: spec.model,
      fullLabel,
      wifiGen: spec.wifi.generation,
      has5G: Boolean(spec.cellular.has5G),
      searchTokens,
      compactKey,
      priority
    });
  };

  // 1. APPLE (2015–2026: iPhone 6s ao 17 Pro Max, SE, XR, XS, iPad)
  const iphoneSeeds = [
    ['iPhone 16', 100], ['iPhone 16 Plus', 98], ['iPhone 16 Pro', 99], ['iPhone 16 Pro Max', 100], ['iPhone 16e', 96],
    ['iPhone 15', 97], ['iPhone 15 Plus', 95], ['iPhone 15 Pro', 96], ['iPhone 15 Pro Max', 98],
    ['iPhone 14', 94], ['iPhone 14 Plus', 91], ['iPhone 14 Pro', 93], ['iPhone 14 Pro Max', 95],
    ['iPhone 13', 94], ['iPhone 13 Mini', 88], ['iPhone 13 Pro', 91], ['iPhone 13 Pro Max', 93],
    ['iPhone 12', 90], ['iPhone 12 Mini', 84], ['iPhone 12 Pro', 88], ['iPhone 12 Pro Max', 90],
    ['iPhone 11', 92], ['iPhone 11 Pro', 86], ['iPhone 11 Pro Max', 88],
    ['iPhone XR', 85], ['iPhone XS', 82], ['iPhone XS Max', 83], ['iPhone X', 82],
    ['iPhone SE', 84], ['iPhone SE 2022', 85],
    ['iPhone 8', 78], ['iPhone 8 Plus', 80], ['iPhone 7', 75], ['iPhone 7 Plus', 77],
    ['iPhone 6s', 72], ['iPhone 6s Plus', 73],
    ['iPhone 17', 92], ['iPhone 17 Air', 90], ['iPhone 17 Pro', 92], ['iPhone 17 Pro Max', 93],
    ['iPad 10', 80], ['iPad Air 6', 82], ['iPad Pro 11', 84], ['iPad Mini 7', 79]
  ];
  for (const [seed, prio] of iphoneSeeds) registerModel('apple', seed, Number(prio));

  // 2. SAMSUNG (2015–2026: Galaxy S6..S26, A01..A80, M01..M62, Z Flip/Fold 1..7, Note 5..20, J1..J8)
  const samsungFeatured = [
    ['Galaxy A06', 100], ['Galaxy A06 5G', 95], ['Galaxy A15', 99], ['Galaxy A15 5G', 99],
    ['Galaxy A16', 97], ['Galaxy A16 5G', 98], ['Galaxy A05', 95], ['Galaxy A05s', 96],
    ['Galaxy A25', 96], ['Galaxy A26', 94], ['Galaxy A35', 98], ['Galaxy A36', 95],
    ['Galaxy A54', 99], ['Galaxy A55', 100], ['Galaxy A56', 97], ['Galaxy A34', 96],
    ['Galaxy A14', 95], ['Galaxy A14 5G', 95], ['Galaxy A24', 93], ['Galaxy A10', 96],
    ['Galaxy A10s', 90], ['Galaxy A71', 94], ['Galaxy A51', 92], ['Galaxy A52', 91],
    ['Galaxy A52s', 92], ['Galaxy A53', 93], ['Galaxy A72', 89], ['Galaxy A73', 91],
    ['Galaxy S25', 99], ['Galaxy S25 Plus', 97], ['Galaxy S25 Ultra', 100], ['Galaxy S25 FE', 99], ['Galaxy S25 Edge', 94],
    ['Galaxy S24', 98], ['Galaxy S24 Plus', 96], ['Galaxy S24 Ultra', 99], ['Galaxy S24 FE', 98],
    ['Galaxy S23', 97], ['Galaxy S23 Plus', 94], ['Galaxy S23 Ultra', 98], ['Galaxy S23 FE', 97],
    ['Galaxy S22', 92], ['Galaxy S22 Plus', 90], ['Galaxy S22 Ultra', 94],
    ['Galaxy S21', 89], ['Galaxy S21 Plus', 87], ['Galaxy S21 Ultra', 91], ['Galaxy S21 FE', 93],
    ['Galaxy S20', 86], ['Galaxy S20 Plus', 85], ['Galaxy S20 Ultra', 87], ['Galaxy S20 FE', 94],
    ['Galaxy Z Flip 6', 95], ['Galaxy Z Fold 6', 95], ['Galaxy Z Flip 5', 93], ['Galaxy Z Fold 5', 93],
    ['Galaxy Z Flip 4', 89], ['Galaxy Z Fold 4', 89], ['Galaxy Z Flip 3', 86], ['Galaxy Z Fold 3', 86],
    ['Galaxy M55', 93], ['Galaxy M54', 94], ['Galaxy M35', 92], ['Galaxy M34', 92], ['Galaxy M15', 91], ['Galaxy M14', 91]
  ];
  for (const [seed, prio] of samsungFeatured) registerModel('samsung', seed, Number(prio));

  for (const aCode of [
    'A01', 'A01 Core', 'A02', 'A02s', 'A03', 'A03s', 'A03 Core', 'A04', 'A04e', 'A04s',
    'A11', 'A12', 'A13', 'A13 5G', 'A20', 'A20s', 'A21s', 'A22', 'A22 5G', 'A23', 'A23 5G',
    'A30', 'A30s', 'A31', 'A32', 'A32 5G', 'A33', 'A50', 'A50s', 'A70', 'A80',
    'M01', 'M02', 'M10', 'M12', 'M13', 'M21s', 'M22', 'M23', 'M30', 'M31', 'M32', 'M33', 'M51', 'M52', 'M53', 'M62',
    'S10', 'S10e', 'S10 Plus', 'S10 Lite', 'S9', 'S9 Plus', 'S8', 'S8 Plus', 'S7', 'S7 Edge', 'S6', 'S6 Edge',
    'Note 20', 'Note 20 Ultra', 'Note 10', 'Note 10 Plus', 'Note 10 Lite', 'Note 9', 'Note 8', 'Note 5',
    'J2 Prime', 'J2 Core', 'J4', 'J4 Core', 'J4 Plus', 'J5', 'J5 Prime', 'J5 Pro', 'J6', 'J6 Plus', 'J7', 'J7 Prime', 'J7 Pro', 'J7 Neo', 'J8'
  ]) {
    registerModel('samsung', `Galaxy ${aCode}`, 75);
  }

  // 3. MOTOROLA (2015–2026: Moto G3..G200, Moto E2..E40, Edge 20..60, Razr 40..60)
  const motoSeeds = [
    ['Moto G84', 100], ['Moto G85', 99], ['Moto G54', 100], ['Moto G55', 97],
    ['Moto G34', 98], ['Moto G35', 97], ['Moto G24', 98], ['Moto G24 Power', 95],
    ['Moto G14', 94], ['Moto G15', 93], ['Moto G04', 95], ['Moto G04s', 96], ['Moto G05', 93],
    ['Moto G75', 95], ['Moto E22', 99], ['Moto E22i', 92], ['Moto E13', 96], ['Moto E14', 94], ['Moto E32', 91], ['Moto E20', 89], ['Moto E40', 88],
    ['Motorola Edge 50 Pro', 98], ['Motorola Edge 50 Fusion', 97], ['Motorola Edge 50 Neo', 97], ['Motorola Edge 50 Ultra', 96], ['Motorola Edge 50', 95],
    ['Motorola Edge 40', 95], ['Motorola Edge 40 Neo', 96], ['Motorola Edge 40 Pro', 92],
    ['Motorola Edge 30', 92], ['Motorola Edge 30 Neo', 93], ['Motorola Edge 30 Fusion', 92], ['Motorola Edge 30 Ultra', 93], ['Motorola Edge 30 Pro', 91],
    ['Motorola Edge 20', 88], ['Motorola Edge 20 Pro', 88], ['Motorola Edge 20 Lite', 86],
    ['Motorola Razr 50', 94], ['Motorola Razr 50 Ultra', 95], ['Motorola Razr 40', 92], ['Motorola Razr 40 Ultra', 93],
    ['Moto G73', 91], ['Moto G72', 89], ['Moto G71', 87], ['Moto G62', 88], ['Moto G60', 90], ['Moto G60s', 88],
    ['Moto G53', 92], ['Moto G52', 93], ['Moto G50', 86], ['Moto G42', 88], ['Moto G41', 85], ['Moto G32', 90], ['Moto G31', 88], ['Moto G30', 88],
    ['Moto G23', 90], ['Moto G22', 89], ['Moto G20', 88], ['Moto G13', 87], ['Moto G10', 85], ['Moto G82', 90], ['Moto G100', 90], ['Moto G200', 90],
    ['Moto G9 Play', 86], ['Moto G9 Power', 86], ['Moto G9 Plus', 87],
    ['Moto G8', 83], ['Moto G8 Play', 84], ['Moto G8 Power', 85], ['Moto G8 Plus', 85], ['Moto G8 Power Lite', 83],
    ['Moto G7', 81], ['Moto G7 Play', 82], ['Moto G7 Power', 83], ['Moto G7 Plus', 82],
    ['Moto G6', 78], ['Moto G6 Play', 79], ['Moto G6 Plus', 79],
    ['Moto G5', 75], ['Moto G5 Plus', 76], ['Moto G5s', 75], ['Moto G5s Plus', 76], ['Moto G4', 73], ['Moto G4 Plus', 74], ['Moto G3', 71],
    ['Moto E7', 84], ['Moto E7 Plus', 84], ['Moto E7 Power', 84], ['Moto E6s', 80], ['Moto E6i', 79], ['Moto E6 Plus', 80], ['Moto E5', 75], ['Moto E4', 73]
  ];
  for (const [seed, prio] of motoSeeds) registerModel('motorola', seed, Number(prio));

  // 4. XIAOMI / REDMI (2015–2026: Redmi Note 5..14 Pro+, Redmi 6..14C, Redmi A1..A4, Xiaomi 11..15)
  const xiaomiSeeds = [
    ['Redmi Note 13', 100], ['Redmi Note 13 5G', 98], ['Redmi Note 13 Pro', 99], ['Redmi Note 13 Pro 5G', 100], ['Redmi Note 13 Pro Plus', 99],
    ['Redmi Note 14', 97], ['Redmi Note 14 5G', 96], ['Redmi Note 14 Pro', 97], ['Redmi Note 14 Pro 5G', 98], ['Redmi Note 14 Pro Plus', 98],
    ['Redmi 13C', 100], ['Redmi 14C', 98], ['Redmi 12C', 95], ['Redmi 13', 94], ['Redmi 12', 95], ['Redmi 12 5G', 93],
    ['Redmi A3', 94], ['Redmi A2', 91], ['Redmi A1', 88],
    ['Redmi Note 12', 98], ['Redmi Note 12 5G', 95], ['Redmi Note 12 Pro', 96], ['Redmi Note 12 Pro 5G', 97], ['Redmi Note 12 Pro Plus', 95], ['Redmi Note 12S', 94],
    ['Redmi Note 11', 95], ['Redmi Note 11S', 94], ['Redmi Note 11 Pro', 93], ['Redmi Note 11 Pro 5G', 93],
    ['Redmi Note 10', 91], ['Redmi Note 10S', 90], ['Redmi Note 10 Pro', 92], ['Redmi Note 10 5G', 89],
    ['Redmi Note 9', 89], ['Redmi Note 9S', 89], ['Redmi Note 9 Pro', 90],
    ['Redmi Note 8', 88], ['Redmi Note 8 Pro', 88], ['Redmi Note 7', 84],
    ['Redmi 10', 87], ['Redmi 10C', 91], ['Redmi 10A', 86], ['Redmi 9', 85], ['Redmi 9A', 85], ['Redmi 9C', 86], ['Redmi 9T', 84], ['Redmi 8', 80], ['Redmi 8A', 79], ['Redmi 7', 77], ['Redmi 7A', 76],
    ['Xiaomi 14', 97], ['Xiaomi 14 Pro', 95], ['Xiaomi 14 Ultra', 97], ['Xiaomi 14T', 95], ['Xiaomi 14T Pro', 96],
    ['Xiaomi 15', 94], ['Xiaomi 15 Pro', 94], ['Xiaomi 15 Ultra', 95],
    ['Xiaomi 13', 94], ['Xiaomi 13 Pro', 93], ['Xiaomi 13 Ultra', 94], ['Xiaomi 13T', 93], ['Xiaomi 13T Pro', 94], ['Xiaomi 13 Lite', 90],
    ['Xiaomi 12', 90], ['Xiaomi 12 Pro', 89], ['Xiaomi 12T', 90], ['Xiaomi 12T Pro', 91], ['Xiaomi 12 Lite', 88],
    ['Xiaomi 11T', 88], ['Xiaomi 11T Pro', 89], ['Mi 11', 87], ['Mi 10', 84], ['Mi 9', 82], ['Mi 8', 79]
  ];
  for (const [seed, prio] of xiaomiSeeds) registerModel('xiaomi', seed, Number(prio));

  // 5. POCO (2018–2026: Poco X, F, M, C)
  const pocoSeeds = [
    ['Poco X6 Pro', 100], ['Poco X6', 99], ['Poco X6 Neo', 93],
    ['Poco X7 Pro', 98], ['Poco X7', 97],
    ['Poco F6', 99], ['Poco F6 Pro', 99], ['Poco F5', 96], ['Poco F5 Pro', 95], ['Poco F4', 91], ['Poco F4 GT', 90], ['Poco F3', 92],
    ['Poco X5 Pro', 96], ['Poco X5', 95], ['Poco X4 Pro', 92], ['Poco X4 GT', 90], ['Poco X3 Pro', 95], ['Poco X3', 92], ['Poco X3 GT', 89],
    ['Poco M6 Pro', 96], ['Poco M6', 94], ['Poco M5', 90], ['Poco M5s', 91], ['Poco M4 Pro', 89], ['Poco M3', 87],
    ['Poco C65', 97], ['Poco C75', 96], ['Poco C55', 90], ['Poco C50', 85], ['Poco C40', 86]
  ];
  for (const [seed, prio] of pocoSeeds) registerModel('poco', seed, Number(prio));

  // 6. REALME (2018–2026: Realme C, Série Numerada, Note, GT)
  const realmeSeeds = [
    ['Realme C67', 100], ['Realme C55', 99], ['Realme C53', 97], ['Realme C65', 96], ['Realme C63', 95], ['Realme C61', 94], ['Realme C75', 95],
    ['Realme C51', 92], ['Realme C35', 91], ['Realme C33', 89], ['Realme C30', 86], ['Realme C25', 84], ['Realme C21Y', 84], ['Realme C11', 83],
    ['Realme Note 50', 96], ['Realme Note 60', 95],
    ['Realme 12 Pro Plus', 99], ['Realme 12 Pro', 98], ['Realme 12', 96], ['Realme 12 5G', 95],
    ['Realme 13 Pro Plus', 97], ['Realme 13 Pro', 96], ['Realme 13', 94],
    ['Realme 11 Pro Plus', 96], ['Realme 11 Pro', 95], ['Realme 11', 93], ['Realme 10', 90], ['Realme 9 Pro', 88], ['Realme 8', 85], ['Realme 7', 82],
    ['Realme GT 6', 97], ['Realme GT 2 Pro', 91], ['Realme GT Neo 3', 90]
  ];
  for (const [seed, prio] of realmeSeeds) registerModel('realme', seed, Number(prio));

  // 7. INFINIX (2018–2026: Hot, Note, Smart, GT, Zero)
  const infinixSeeds = [
    ['Infinix Hot 40 Pro', 100], ['Infinix Hot 40', 98], ['Infinix Hot 50 Pro', 97], ['Infinix Hot 50', 96],
    ['Infinix Hot 30', 97], ['Infinix Hot 30 Play', 94], ['Infinix Hot 20', 92], ['Infinix Hot 11', 90],
    ['Infinix Note 40 Pro', 98], ['Infinix Note 40', 97], ['Infinix Note 30', 96], ['Infinix Note 30 Pro', 96], ['Infinix Note 12', 91],
    ['Infinix Smart 8', 95], ['Infinix Smart 8 Pro', 94], ['Infinix Smart 7', 91], ['Infinix Smart 9', 93],
    ['Infinix GT 20 Pro', 97], ['Infinix GT 10 Pro', 95], ['Infinix Zero 30', 94], ['Infinix Zero 40', 94]
  ];
  for (const [seed, prio] of infinixSeeds) registerModel('infinix', seed, Number(prio));

  // 8. OUTRAS (Asus Zenfone/ROG, Google Pixel, OnePlus, Honor, Oppo)
  const outrasSeeds = [
    ['Asus Zenfone 10', 100], ['Asus Zenfone 11 Ultra', 98], ['Asus Zenfone 9', 96], ['Asus Zenfone 8', 91],
    ['Asus ROG Phone 8 Pro', 98], ['Asus ROG Phone 7', 95], ['Asus ROG Phone 6', 93],
    ['Google Pixel 9 Pro', 99], ['Google Pixel 9', 98], ['Google Pixel 8 Pro', 97], ['Google Pixel 8', 96], ['Google Pixel 8a', 95], ['Google Pixel 7 Pro', 93], ['Google Pixel 7', 92], ['Google Pixel 6', 89],
    ['OnePlus 12', 98], ['OnePlus 13', 97], ['OnePlus 11', 94], ['OnePlus Nord 3', 92], ['OnePlus Nord CE 3', 90],
    ['Honor Magic 6 Pro', 95], ['Honor Magic 6 Lite', 94], ['Honor X8b', 92], ['Honor 90', 91],
    ['Oppo Reno 11', 94], ['Oppo Reno 12 Pro', 95], ['Oppo Find X7', 92]
  ];
  for (const [seed, prio] of outrasSeeds) registerModel('outras', seed, Number(prio));

  return byBrand;
}

let brandCatalogCache = null;

function getBrandCatalog() {
  if (!brandCatalogCache) {
    brandCatalogCache = buildBrandCatalog2015To2026();
  }
  return brandCatalogCache;
}

/**
 * Calcula distância de edição simples (Levenshtein limitada) para tolerar pequenos erros de digitação.
 */
function isApproxTokenMatch(queryTok, targetTok) {
  if (targetTok.includes(queryTok) || queryTok.includes(targetTok)) return true;
  if (queryTok.length < 4 || targetTok.length < 4) return false;
  if (Math.abs(queryTok.length - targetTok.length) > 1) return false;

  let mismatches = 0;
  const minLen = Math.min(queryTok.length, targetTok.length);
  for (let i = 0; i < minLen; i++) {
    if (queryTok[i] !== targetTok[i]) {
      // Verifica transposição simples de letras adjacentes (ex.: "ipohne" -> "iphone")
      if (
        i + 1 < minLen &&
        queryTok[i] === targetTok[i + 1] &&
        queryTok[i + 1] === targetTok[i]
      ) {
        i++;
        mismatches++;
      } else {
        mismatches++;
      }
      if (mismatches > 1) return false;
    }
  }
  return mismatches <= 1;
}

/**
 * Retorna sugestões instantâneas coerentes (2015–2026) conforme as teclas digitadas dentro da marca selecionada.
 */
export function getBrandModelSuggestions(brandId, rawInput = '', limit = 10) {
  const catalogByBrand = getBrandCatalog();
  const brandEntries = brandId && catalogByBrand[brandId]
    ? catalogByBrand[brandId]
    : Object.values(catalogByBrand).flat();

  const cleaned = sanitizeDeviceQuery(rawInput);
  if (!cleaned) {
    return brandEntries
      .slice()
      .sort((a, b) => b.priority - a.priority)
      .slice(0, limit);
  }

  const scoped = scopeQueryToBrand(cleaned, brandId);
  if (isPre2015DeviceQuery(scoped)) {
    return [];
  }

  const expanded = expandTolerantDeviceQuery(scoped);
  const queryTokens = normalizeTokens(expanded).filter((t) => !ACCESSORY_NOISE_TOKENS.has(t));
  const rawUserTokens = normalizeTokens(cleaned).filter(
    (t) => !ACCESSORY_NOISE_TOKENS.has(t) && !BRAND_TOKENS.has(t)
  );
  const effectiveTokens = rawUserTokens.length > 0 ? rawUserTokens : queryTokens;
  const compactQuery = effectiveTokens.join('');

  const scored = [];

  for (const item of brandEntries) {
    let score = 0;
    let matchedCount = 0;

    for (const qt of effectiveTokens) {
      if (item.searchTokens.includes(qt)) {
        score += 25;
        matchedCount++;
      } else if (item.searchTokens.some((st) => st.startsWith(qt))) {
        score += 14;
        matchedCount++;
      } else if (
        !/\d/.test(qt) &&
        item.searchTokens.some((st) => isApproxTokenMatch(qt, st))
      ) {
        score += 8;
        matchedCount++;
      }
    }

    if (matchedCount === 0 && compactQuery.length >= 2 && item.compactKey.includes(compactQuery)) {
      score += 12;
      matchedCount = 1;
    }

    if (matchedCount < effectiveTokens.length && effectiveTokens.length > 1) {
      // Exige que todos os tokens significativos batam (ou prefixo do último token sendo digitado)
      const allButLastMatched = effectiveTokens
        .slice(0, -1)
        .every((qt) => item.searchTokens.includes(qt) || (!/\d/.test(qt) && item.searchTokens.some((st) => isApproxTokenMatch(qt, st))));
      const lastTok = effectiveTokens[effectiveTokens.length - 1];
      const lastPrefixMatched = item.searchTokens.some((st) => st.startsWith(lastTok));
      if (!allButLastMatched || !lastPrefixMatched) {
        continue;
      }
    } else if (matchedCount === 0) {
      continue;
    }

    // Prioriza quando o código numérico principal é exatamente o mesmo (ex.: digitar "15" traz todos os iPhone 15 antes de outros)
    const userNumberTokens = effectiveTokens.filter((t) => /\d/.test(t));
    if (userNumberTokens.length > 0) {
      const exactNumMatches = userNumberTokens.filter((nt) => item.searchTokens.includes(nt)).length;
      score += exactNumMatches * 30;
    }

    score += item.priority * 0.1 - item.searchTokens.length * 0.4;
    scored.push({ item, score });
  }

  // Se o usuário digitou um modelo válido 2015–2026 que ainda não estava pré-listado nos cards, sintetiza e inclui no topo
  const dynamicSpec = resolveKnownFamilySpecs(scoped);
  if (dynamicSpec && !isPre2015DeviceQuery(`${dynamicSpec.manufacturer} ${dynamicSpec.model}`)) {
    const alreadyInScored = scored.some(
      (s) => s.item.model.toLowerCase() === dynamicSpec.model.toLowerCase()
    );
    if (!alreadyInScored) {
      const searchTokens = normalizeTokens(`${dynamicSpec.manufacturer} ${dynamicSpec.model}`);
      scored.unshift({
        item: {
          brandId: brandId || 'outras',
          manufacturer: dynamicSpec.manufacturer,
          model: dynamicSpec.model,
          fullLabel: `${dynamicSpec.manufacturer} ${dynamicSpec.model}`,
          wifiGen: dynamicSpec.wifi.generation,
          has5G: Boolean(dynamicSpec.cellular.has5G),
          searchTokens,
          compactKey: searchTokens.join(''),
          priority: 110
        },
        score: 999
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}
export function resolveKnownFamilySpecs(rawQueryOrModel) {
  const expanded = expandTolerantDeviceQuery(rawQueryOrModel);
  if (!expanded || isPre2015DeviceQuery(expanded)) return null;

  const rawTokens = normalizeTokens(expanded);
  const hasRaw = (t) => rawTokens.includes(t);
  // Filtra ruído de capacidade/SIM/conectividade para não falhar em "iPhone 15 128GB", "Moto G84 5G 256GB", etc.
  const tokens = rawTokens.filter((t) => !ACCESSORY_NOISE_TOKENS.has(t));
  if (tokens.length === 0) return null;

  const hasToken = (t) => tokens.includes(t);
  const modelCodes = extractModelCodeTokens(tokens);

  // 1. APPLE (2015–2026: iPhone 6s a 17, SE, X/XR/XS e iPad)
  if (
    hasToken('iphone') ||
    hasToken('ipad') ||
    (hasToken('apple') && tokens.some((t) => /^(?:6s|[78]|x[rs]?|se|1[1-7]e?)$/.test(t)))
  ) {
    if (hasToken('ipad')) {
      const isPro = hasToken('pro');
      const isAir = hasToken('air');
      const isMini = hasToken('mini');
      const genToken = modelCodes[0] || '';
      const num = parseInt(genToken.replace(/\D/g, ''), 10);
      if (num > 13) return null;
      const tierLabel = isPro ? 'Pro' : isAir ? 'Air' : isMini ? 'Mini' : '';
      const modelName = ['iPad', tierLabel, genToken ? genToken.toUpperCase() : ''].filter(Boolean).join(' ');
      const wifiGen = isPro || isAir ? 'Wi-Fi 6E' : 'Wi-Fi 6';
      return buildWifiAndCellPayload({
        manufacturer: 'Apple',
        model: modelName,
        wifiGen,
        has5G: isPro || isAir || hasRaw('5g')
      });
    }

    const genToken = tokens.find((t) => /^(?:6s|7|8|x|xr|xs|se|1[1-7]e?)$/.test(t));
    if (!genToken) return null;
    if (modelCodes.some((c) => c !== genToken)) return null;

    const isPro = hasToken('pro');
    const isMax = hasToken('max');
    const isPlus = hasToken('plus');
    const isMini = hasToken('mini');
    const isAir = hasToken('air');

    const numGen = parseInt(genToken, 10);
    if (isMini && numGen !== 12 && numGen !== 13) return null;
    if (isAir && numGen !== 17) return null;
    if (isPro && !['11', '12', '13', '14', '15', '16', '17'].includes(genToken)) return null;
    if (isMax && !isPro && genToken !== 'xs') return null;
    if (isPlus && !['6s', '7', '8', '14', '15', '16', '17'].includes(genToken)) return null;

    const suffix = [
      isPro ? 'Pro' : '',
      isMax ? 'Max' : '',
      isPlus ? 'Plus' : '',
      isMini ? 'Mini' : '',
      isAir ? 'Air' : ''
    ]
      .filter(Boolean)
      .join(' ');

    const displayGen =
      genToken === 'se'
        ? 'SE'
        : genToken === 'xr'
          ? 'XR'
          : genToken === 'xs'
            ? 'XS'
            : genToken === 'x'
              ? 'X'
              : genToken;
    const modelName = `iPhone ${displayGen}${suffix ? ` ${suffix}` : ''}`;

    let wifiGen = 'Wi-Fi 6';
    let has5G = true;
    let chipset = null;

    if (['6s', '7', '8', 'x', 'xr', 'xs'].includes(genToken)) {
      wifiGen = 'Wi-Fi 5';
      has5G = false;
      chipset =
        genToken === 'xr' || genToken === 'xs'
          ? 'Apple A12 Bionic'
          : genToken === '8' || genToken === 'x'
            ? 'Apple A11 Bionic'
            : 'Apple A9 / A10 Fusion';
    } else if (genToken === '11') {
      wifiGen = 'Wi-Fi 6';
      has5G = false;
      chipset = 'Apple A13 Bionic';
    } else if (genToken === 'se') {
      wifiGen = 'Wi-Fi 6';
      has5G = hasRaw('2022') || hasRaw('5g') || hasToken('3');
      chipset = has5G ? 'Apple A15 Bionic' : 'Apple A13 Bionic';
    } else if (genToken === '12') {
      chipset = 'Apple A14 Bionic';
    } else if (genToken === '13') {
      chipset = 'Apple A15 Bionic';
    } else if (genToken === '14') {
      chipset = isPro ? 'Apple A16 Bionic' : 'Apple A15 Bionic';
    } else if (genToken === '15') {
      wifiGen = isPro ? 'Wi-Fi 6E' : 'Wi-Fi 6';
      chipset = isPro ? 'Apple A17 Pro' : 'Apple A16 Bionic';
    } else if (genToken === '16e') {
      wifiGen = 'Wi-Fi 6';
      chipset = 'Apple A18';
    } else if (genToken === '16' || genToken === '17') {
      wifiGen = 'Wi-Fi 7';
      chipset =
        genToken === '17'
          ? isPro
            ? 'Apple A19 Pro'
            : 'Apple A19'
          : isPro
            ? 'Apple A18 Pro'
            : 'Apple A18';
    }

    return buildWifiAndCellPayload({
      manufacturer: 'Apple',
      model: modelName,
      wifiGen,
      has5G,
      chipset
    });
  }

  // 2. SAMSUNG GALAXY (Séries S, Note, Z, Tab, A, M, F, J)
  const isSamsungContext =
    hasToken('samsung') ||
    hasToken('galaxy') ||
    hasToken('flip') ||
    hasToken('fold') ||
    tokens.some((t) =>
      /^(?:s(?:[6-9]|10|2[0-6])e?|a(?:[356789]|0[1-7]|[1-8][0-7]|90)[se]?|[mf](?:0[1-7]|[1-6][0-7])[se]?|j[1-8])$/.test(t)
    );

  if (
    isSamsungContext &&
    !hasToken('poco') &&
    !hasToken('redmi') &&
    !hasToken('xiaomi') &&
    !hasToken('motorola') &&
    !hasToken('moto') &&
    !hasToken('infinix') &&
    !hasToken('realme') &&
    !hasToken('oppo')
  ) {
    // 2a. Galaxy Z Flip / Z Fold (1 a 7)
    if (hasToken('flip') || hasToken('fold')) {
      const form = hasToken('fold') ? 'Fold' : 'Flip';
      const genToken = tokens.find((t) => /^[1-7]$/.test(t));
      if (modelCodes.some((c) => c !== genToken)) return null;

      const genNum = genToken ? parseInt(genToken, 10) : 1;
      const isFE = hasToken('fe');
      const wifiGen = genNum >= 6 && !isFE ? 'Wi-Fi 7' : genNum >= 4 ? 'Wi-Fi 6E' : 'Wi-Fi 6';
      const has5G = genNum >= 2 || hasRaw('5g');

      return buildWifiAndCellPayload({
        manufacturer: 'Samsung',
        model: `Galaxy Z ${form}${genToken ? ` ${genToken}` : ''}${isFE ? ' FE' : ''}`,
        wifiGen,
        has5G
      });
    }

    // 2b. Galaxy Tab (Tab A / Tab S)
    if (hasToken('tab')) {
      const tabCode = modelCodes[0] || '';
      const isTabS = /^s\d+/i.test(tabCode) || hasToken('s');
      const isFE = hasToken('fe');
      const isLite = hasToken('lite');
      const isUltra = hasToken('ultra');
      const isPlus = hasToken('plus');
      const suffix = [
        tabCode ? tabCode.toUpperCase() : '',
        isFE ? 'FE' : '',
        isUltra ? 'Ultra' : '',
        isPlus ? 'Plus' : '',
        isLite ? 'Lite' : ''
      ]
        .filter(Boolean)
        .join(' ');
      const wifiGen = isTabS && !isLite ? 'Wi-Fi 6' : 'Wi-Fi 5';
      return buildWifiAndCellPayload({
        manufacturer: 'Samsung',
        model: `Galaxy Tab${suffix ? ` ${suffix}` : ''}`,
        wifiGen,
        has5G: hasRaw('5g') || (isTabS && !isLite)
      });
    }

    // 2c. Galaxy Note (Note 4 a 10, Note 20)
    if (hasToken('note')) {
      const genToken = tokens.find((t) => /^(?:[45789]|10|20)$/.test(t));
      if (!genToken || modelCodes.some((c) => c !== genToken)) return null;

      const num = parseInt(genToken, 10);
      const isLite = hasToken('lite');
      const isUltra = hasToken('ultra');
      const isPlus = hasToken('plus');
      const wifiGen = num >= 10 && !isLite ? 'Wi-Fi 6' : 'Wi-Fi 5';
      const has5G = num === 20 || hasRaw('5g');
      const suffix = [
        isUltra ? 'Ultra' : '',
        isPlus ? 'Plus' : '',
        isLite ? 'Lite' : '',
        hasRaw('5g') ? '5G' : ''
      ]
        .filter(Boolean)
        .join(' ');

      return buildWifiAndCellPayload({
        manufacturer: 'Samsung',
        model: `Galaxy Note ${num}${suffix ? ` ${suffix}` : ''}`,
        wifiGen,
        has5G
      });
    }

    // 2d. Galaxy S (S6 a S10, S20 a S26)
    const sToken = tokens.find((t) => /^s(?:[6-9]|10|2[0-6])e?$/.test(t));
    if (sToken && !modelCodes.some((c) => c !== sToken)) {
      const num = parseInt(sToken.replace(/\D/g, ''), 10);
      const isE = sToken.endsWith('e');
      const isFE = hasToken('fe');
      const isUltra = hasToken('ultra');
      const isPlus = hasToken('plus');
      const isLite = hasToken('lite');
      const isEdge = hasToken('edge');

      if (isFE && ![20, 21, 23, 24, 25].includes(num)) return null;
      if (isUltra && num < 20) return null;
      if (isLite && num !== 10) return null;

      const suffix = [
        isFE ? 'FE' : '',
        isUltra ? 'Ultra' : '',
        isPlus ? 'Plus' : '',
        isLite ? 'Lite' : '',
        isEdge ? 'Edge' : '',
        hasRaw('5g') && !isFE ? '5G' : ''
      ]
        .filter(Boolean)
        .join(' ');

      const baseCode = isE ? `S${num}e` : `S${num}`;
      const modelName = `Galaxy ${baseCode}${suffix ? ` ${suffix}` : ''}`;

      let wifiGen = 'Wi-Fi 6';
      let has5G = num >= 20;

      if (num <= 9 || isE || isLite) {
        wifiGen = 'Wi-Fi 5';
        has5G = false;
      } else if (num === 10 || num === 20 || (num === 21 && !isUltra)) {
        wifiGen = 'Wi-Fi 6';
        has5G = num >= 20 || hasRaw('5g');
      } else if (
        (num === 21 && isUltra) ||
        num === 22 ||
        num === 23 ||
        (num === 24 && !isUltra) ||
        (num === 25 && isFE)
      ) {
        wifiGen = 'Wi-Fi 6E';
        has5G = true;
      } else if ((num === 24 && isUltra) || num >= 25) {
        wifiGen = 'Wi-Fi 7';
        has5G = true;
      }

      return buildWifiAndCellPayload({
        manufacturer: 'Samsung',
        model: modelName,
        wifiGen,
        has5G
      });
    }

    // 2e. Galaxy A, M, F e J (incluindo A3..A9, A01..A90, M01..M62, F02s..F62, J1..J8)
    const amjToken = tokens.find((t) => /^(?:[amf]\d{1,2}[se]?|j[1-8])$/.test(t));
    if (amjToken && !modelCodes.some((c) => c !== amjToken)) {
      const seriesLetter = amjToken[0].toUpperCase();
      const digitsMatch = amjToken.match(/\d+/);
      const digits = digitsMatch ? digitsMatch[0] : '';
      const trailingChar = amjToken.slice(1 + digits.length).toLowerCase();

      if (seriesLetter === 'A' || seriesLetter === 'M' || seriesLetter === 'F') {
        if (digits.length === 1) {
          // Clássicos Galaxy A3, A5, A6, A7, A8, A9
          if (seriesLetter !== 'A' || !['3', '5', '6', '7', '8', '9'].includes(digits)) return null;
        } else if (digits.length === 2) {
          const tierDigit = parseInt(digits[0], 10);
          const genDigit = parseInt(digits[1], 10);
          // Rejeita modelos inexistentes como A09, A99, M99
          if (genDigit > 7) return null;
          if (tierDigit === 9 && digits !== '90') return null;
        } else {
          return null;
        }
      }

      const isCore = hasToken('core');
      const isPrime = hasToken('prime');
      const isPro = hasToken('pro');
      const isNeo = hasToken('neo');
      const isPlus = hasToken('plus');

      const only24GhzSet = new Set([
        'a3', 'a01', 'a02', 'a02s', 'a03', 'a03s', 'a10', 'a10s', 'a10e', 'a11', 'a20', 'a20s', 'a20e',
        'm01', 'm02', 'm10', 'm11', 'j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j7', 'j8'
      ]);
      const wifi6Set = new Set([
        'a35', 'a36', 'a37', 'a54', 'a55', 'a56', 'a57', 'a73', 'm35', 'm36', 'm54', 'm55', 'm56', 'f54', 'f55'
      ]);
      const default5GSet = new Set([
        'a16', 'a25', 'a26', 'a27', 'a33', 'a34', 'a35', 'a36', 'a37', 'a42', 'a52s', 'a53', 'a54', 'a55', 'a56', 'a57', 'a73', 'a82', 'a90',
        'm14', 'm15', 'm16', 'm23', 'm33', 'm34', 'm35', 'm36', 'm42', 'm52', 'm53', 'm54', 'm55', 'm56',
        'f14', 'f15', 'f23', 'f34', 'f42', 'f52', 'f54', 'f55'
      ]);

      const isOnly24 =
        isCore ||
        (only24GhzSet.has(amjToken) && !(seriesLetter === 'J' && isPro));

      const wifiGen = isOnly24 ? 'Wi-Fi 4' : wifi6Set.has(amjToken) ? 'Wi-Fi 6' : 'Wi-Fi 5';
      const has5G = !isOnly24 && (hasRaw('5g') || default5GSet.has(amjToken));

      const suffix = [
        isCore ? 'Core' : '',
        isPrime ? 'Prime' : '',
        isPro ? 'Pro' : '',
        isNeo ? 'Neo' : '',
        isPlus ? 'Plus' : '',
        hasRaw('5g') ? '5G' : ''
      ]
        .filter(Boolean)
        .join(' ');

      const formattedCode = `${seriesLetter}${digits}${trailingChar}`;
      return buildWifiAndCellPayload({
        manufacturer: 'Samsung',
        model: `Galaxy ${formattedCode}${suffix ? ` ${suffix}` : ''}`,
        wifiGen,
        has5G
      });
    }
  }

  // 3. MOTOROLA (Moto G, Moto E, Motorola Edge, Motorola Razr, Motorola One, Moto Z/X)
  const isMotoContext =
    hasToken('motorola') ||
    hasToken('moto') ||
    hasToken('razr') ||
    (hasToken('edge') && !hasToken('samsung') && !hasToken('galaxy')) ||
    tokens.some((t) => /^(?:e[1-7][is]?|e1[345]|e2[023]i?|e3[02]s?|e40|g\d{1,3}s?)$/.test(t));

  if (isMotoContext) {
    // 3a. Motorola Razr (Razr 5G, Razr 40, 40 Ultra, 50, 50 Ultra, 60, 60 Ultra)
    if (hasToken('razr')) {
      const genToken = tokens.find((t) => /^(?:40|50|60)$/.test(t));
      if (modelCodes.some((c) => c !== genToken)) return null;
      const genNum = genToken ? parseInt(genToken, 10) : 40;
      const isUltra = hasToken('ultra');
      const isPlus = hasToken('plus');
      const wifiGen = genNum >= 50 && (isUltra || isPlus) ? 'Wi-Fi 7' : genNum >= 40 ? 'Wi-Fi 6E' : 'Wi-Fi 6';
      const suffix = [genToken || '', isUltra ? 'Ultra' : isPlus ? 'Plus' : ''].filter(Boolean).join(' ');
      return buildWifiAndCellPayload({
        manufacturer: 'Motorola',
        model: `Razr${suffix ? ` ${suffix}` : ''}`,
        wifiGen,
        has5G: true
      });
    }

    // 3b. Motorola Edge (Edge, Edge+, Edge 20 a 60 e variantes Neo, Fusion, Pro, Ultra, Lite)
    if (hasToken('edge')) {
      const genToken = tokens.find((t) => /^(?:20|30|40|50|60|70|x30|s30)$/.test(t));
      if (modelCodes.some((c) => c !== genToken)) return null;

      const genNum = genToken ? parseInt(genToken.replace(/\D/g, ''), 10) : 30;
      const isUltra = hasToken('ultra');
      const isPro = hasToken('pro');
      const isNeo = hasToken('neo');
      const isFusion = hasToken('fusion');
      const isLite = hasToken('lite');
      const isPlus = hasToken('plus');

      const wifiGen =
        genNum >= 50 && (isUltra || isPro)
          ? 'Wi-Fi 7'
          : genNum >= 30 && !isLite
            ? 'Wi-Fi 6E'
            : 'Wi-Fi 6';
      const suffix = [
        genToken ? genToken.toUpperCase() : '',
        isUltra ? 'Ultra' : '',
        isPro ? 'Pro' : '',
        isFusion ? 'Fusion' : '',
        isNeo ? 'Neo' : '',
        isLite ? 'Lite' : '',
        isPlus ? 'Plus' : ''
      ]
        .filter(Boolean)
        .join(' ');

      return buildWifiAndCellPayload({
        manufacturer: 'Motorola',
        model: `Edge${suffix ? ` ${suffix}` : ''}`,
        wifiGen,
        has5G: true
      });
    }

    // 3c. Motorola One (Vision, Action, Zoom, Macro, Hyper, Fusion, Fusion+)
    if (hasToken('one') && !hasToken('oneplus')) {
      const variant = ['vision', 'action', 'zoom', 'macro', 'hyper', 'fusion', 'power'].find(hasToken);
      const isPlus = hasToken('plus');
      const label = variant ? variant[0].toUpperCase() + variant.slice(1) : '';
      return buildWifiAndCellPayload({
        manufacturer: 'Motorola',
        model: `Motorola One${label ? ` ${label}` : ''}${isPlus ? ' Plus' : ''}`,
        wifiGen: variant === 'macro' ? 'Wi-Fi 4' : 'Wi-Fi 5',
        has5G: hasRaw('5g')
      });
    }

    // 3d. Moto E e Moto G (G1..G9, G04..G86, G100, G200, Moto G 5G/Play/Power/Stylus e E1..E40)
    const egToken = tokens.find((t) => /^(?:e\d{1,2}[is]?|g\d{1,3}s?)$/.test(t));
    if (egToken && !modelCodes.some((c) => c !== egToken)) {
      const line = egToken[0].toUpperCase();
      const numVal = parseInt(egToken.replace(/\D/g, ''), 10);
      const trailing = egToken.replace(/^[eg]\d+/i, '').toLowerCase();

      // Rejeita numerações irreais (ex.: Moto G999, Moto E99)
      if (line === 'E' && (numVal < 1 || numVal > 50)) return null;
      if (line === 'G' && (numVal < 1 || (numVal > 90 && numVal !== 100 && numVal !== 200))) return null;

      const isPlay = hasToken('play');
      const isPower = hasToken('power');
      const isPlus = hasToken('plus');
      const isStylus = hasToken('stylus');
      const isLite = hasToken('lite');

      const only24MotoE = new Set(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e6s', 'e6i', 'e7', 'e20', 'e30', 'e32', 'e32s', 'e40']);
      const only24MotoG = new Set(['g1', 'g2', 'g3', 'g4', 'g5', 'g10']);
      const isOnly24 =
        (line === 'E' && only24MotoE.has(egToken)) ||
        (line === 'G' &&
          (only24MotoG.has(egToken) ||
            isLite ||
            (isPlay && ['g6', 'g7', 'g8', 'g9'].includes(egToken)) ||
            (isPower && egToken === 'g7')));

      const isWifi6 = ['g75', 'g86', 'g100', 'g200'].includes(egToken);
      const wifiGen = isOnly24 ? 'Wi-Fi 4' : isWifi6 ? 'Wi-Fi 6' : 'Wi-Fi 5';
      const isDefault5GMoto =
        line === 'G' &&
        (numVal >= 50 || ['g34', 'g35', 'g45'].includes(egToken)) &&
        !['g52', 'g60', 'g60s', 'g72'].includes(egToken);
      const has5G = !isOnly24 && (hasRaw('5g') || isDefault5GMoto);

      const suffix = [
        isPlay ? 'Play' : '',
        isPower ? 'Power' : '',
        isPlus ? 'Plus' : '',
        isStylus ? 'Stylus' : '',
        isLite ? 'Lite' : '',
        hasRaw('5g') ? '5G' : ''
      ]
        .filter(Boolean)
        .join(' ');

      const displayCode = `${line}${egToken.slice(1, 1 + String(egToken.match(/\d+/)[0]).length)}${trailing}`;
      return buildWifiAndCellPayload({
        manufacturer: 'Motorola',
        model: `Moto ${displayCode}${suffix ? ` ${suffix}` : ''}`,
        wifiGen,
        has5G
      });
    }

    // 3e. Moto G sem número (ex.: "Moto G 5G", "Moto G Stylus", "Moto G Power", "Moto G Play")
    if (
      hasToken('g') &&
      modelCodes.length === 0 &&
      (hasRaw('5g') || hasToken('play') || hasToken('power') || hasToken('stylus'))
    ) {
      const isPlay = hasToken('play');
      const isPower = hasToken('power');
      const isStylus = hasToken('stylus');
      const has5G = hasRaw('5g');
      const suffix = [isPlay ? 'Play' : '', isPower ? 'Power' : '', isStylus ? 'Stylus' : '', has5G ? '5G' : '']
        .filter(Boolean)
        .join(' ');
      return buildWifiAndCellPayload({
        manufacturer: 'Motorola',
        model: `Moto G ${suffix}`,
        wifiGen: 'Wi-Fi 5',
        has5G
      });
    }
  }

  // 4. XIAOMI / REDMI / POCO (aceita "Note 13", "Xiaomi Note 13", "Xiaomi 13C", "Poco X6", "Xiaomi 14", etc.)
  const isPocoCode = tokens.find((t) => /^(?:c[3-7]\d|c3|m[2-7]s?|x[2-7]|f[1-7])$/.test(t));
  if (hasToken('poco') || (isPocoCode && (hasToken('xiaomi') || tokens[0] === isPocoCode))) {
    if (!isPocoCode || modelCodes.some((c) => c !== isPocoCode)) return null;

    const line = isPocoCode[0].toUpperCase();
    const num = parseInt(isPocoCode.slice(1), 10);
    const isPro = hasToken('pro');
    const isGT = hasToken('gt');
    const isNeo = hasToken('neo');
    const isUltra = hasToken('ultra');

    const isOnly24 = line === 'C' && num <= 51;
    const isWifi6EOr7 = (line === 'F' && num >= 6) || (line === 'X' && num >= 6 && isPro);
    const isWifi6 = isWifi6EOr7 || line === 'F' || (line === 'X' && num >= 5 && isPro) || isGT;
    const wifiGen = isOnly24 ? 'Wi-Fi 4' : isWifi6EOr7 ? 'Wi-Fi 6E' : isWifi6 ? 'Wi-Fi 6' : 'Wi-Fi 5';
    const has5G =
      line === 'F' ||
      (line === 'X' && num >= 4) ||
      (line === 'M' && num >= 4 && (isPro || hasRaw('5g') || num >= 6)) ||
      hasRaw('5g');

    const suffix = [
      isUltra ? 'Ultra' : '',
      isPro ? 'Pro' : '',
      isGT ? 'GT' : '',
      isNeo ? 'Neo' : '',
      hasRaw('5g') ? '5G' : ''
    ]
      .filter(Boolean)
      .join(' ');

    return buildWifiAndCellPayload({
      manufacturer: 'POCO',
      model: `Poco ${isPocoCode.toUpperCase()}${suffix ? ` ${suffix}` : ''}`,
      wifiGen,
      has5G
    });
  }

  const redmiCode = tokens.find((t) => /^(?:a[1-5]x?|[5-9][acit]?|1[0-5][acrst]?)$/.test(t));
  const isRedmiContext =
    hasToken('redmi') ||
    (hasToken('note') && redmiCode && !hasToken('samsung') && !hasToken('galaxy') && !hasToken('infinix') && !hasToken('realme')) ||
    (hasToken('xiaomi') && redmiCode && (hasToken('note') || /[ac]$|^a\d/i.test(redmiCode)));

  if (isRedmiContext && redmiCode && !modelCodes.some((c) => c !== redmiCode)) {
    const isNote = hasToken('note');
    const isEntry24 = !isNote && /^(?:a[12]|[6789][ai]?|9c|10a)$/.test(redmiCode);
    const isPro = hasToken('pro');
    const isPlus = hasToken('plus');
    const isMax = hasToken('max');
    const isS = hasToken('s') || redmiCode.endsWith('s');
    const isT = hasToken('t') || redmiCode.endsWith('t');
    const numVal = parseInt(redmiCode.replace(/\D/g, ''), 10);

    const isWifi6 = isNote && numVal >= 11 && isPro && (isPlus || hasRaw('5g') || numVal >= 13);
    const wifiGen = isEntry24 ? 'Wi-Fi 4' : isWifi6 ? 'Wi-Fi 6' : 'Wi-Fi 5';
    const has5G =
      hasRaw('5g') ||
      (isNote && numVal >= 12 && isPro && (isPlus || numVal >= 14));

    const formattedCode = redmiCode.toUpperCase();
    const suffix = [
      isS && !formattedCode.endsWith('S') ? 'S' : '',
      isT && !formattedCode.endsWith('T') ? 'T' : '',
      isPro ? 'Pro' : '',
      isPlus ? 'Plus' : '',
      isMax ? 'Max' : '',
      hasRaw('5g') ? '5G' : hasRaw('4g') ? '4G' : ''
    ]
      .filter(Boolean)
      .join(' ');

    return buildWifiAndCellPayload({
      manufacturer: 'Xiaomi',
      model: `Redmi${isNote ? ' Note' : ''} ${formattedCode}${suffix ? ` ${suffix}` : ''}`,
      wifiGen,
      has5G
    });
  }

  // 4c. Linha principal Xiaomi / Mi (Mi 8, Mi 9, Mi 10, Mi 11, Xiaomi 11T, 12, 12T, 13, 13T, 14, 14T, 15)
  if (hasToken('xiaomi') || hasToken('mi')) {
    const miCode = tokens.find((t) => /^(?:[89]t?|1[0-5][ts]?)$/.test(t));
    if (miCode && !modelCodes.some((c) => c !== miCode)) {
      const numVal = parseInt(miCode.replace(/\D/g, ''), 10);
      const isT = hasToken('t') || miCode.endsWith('t');
      const isPro = hasToken('pro');
      const isUltra = hasToken('ultra');
      const isLite = hasToken('lite');
      const wifiGen =
        numVal >= 14 && !isLite
          ? 'Wi-Fi 7'
          : numVal >= 12 && !isLite
            ? 'Wi-Fi 6E'
            : numVal >= 10
              ? 'Wi-Fi 6'
              : 'Wi-Fi 5';
      const has5G = numVal >= 10 || hasRaw('5g');
      const prefix = numVal <= 10 || (numVal === 11 && hasToken('mi')) ? 'Mi' : 'Xiaomi';
      const baseNum = isT && !miCode.toUpperCase().endsWith('T') ? `${numVal}T` : miCode.toUpperCase();
      const suffix = [isUltra ? 'Ultra' : '', isPro ? 'Pro' : '', isLite ? 'Lite' : '']
        .filter(Boolean)
        .join(' ');
      return buildWifiAndCellPayload({
        manufacturer: 'Xiaomi',
        model: `${prefix} ${baseNum}${suffix ? ` ${suffix}` : ''}`,
        wifiGen,
        has5G
      });
    }
  }

  // 5. REALME (Realme C11..C75, Note 50/60, Realme 6..14 Pro/Pro+, Realme GT)
  if (hasToken('realme') || hasToken('narzo') || tokens.some((t) => /^c(?:11|12|15|2[015]y?|3[0135]s?|5[135]|6[1357]|75)$/.test(t))) {
    if (hasToken('gt')) {
      const gtGen = modelCodes[0] || '';
      const isPro = hasToken('pro');
      const isNeo = hasToken('neo');
      const suffix = [isNeo ? 'Neo' : '', gtGen.toUpperCase(), isPro ? 'Pro' : ''].filter(Boolean).join(' ');
      return buildWifiAndCellPayload({
        manufacturer: 'Realme',
        model: `Realme GT${suffix ? ` ${suffix}` : ''}`,
        wifiGen: 'Wi-Fi 6',
        has5G: true
      });
    }

    const cToken = tokens.find((t) => /^c\d{1,2}[ys]?$/.test(t));
    if (cToken && !modelCodes.some((c) => c !== cToken)) {
      const cNum = parseInt(cToken.slice(1), 10);
      if (cNum > 85) return null;
      const isOnly24 = cNum <= 35;
      return buildWifiAndCellPayload({
        manufacturer: 'Realme',
        model: `Realme ${cToken.toUpperCase()}`,
        wifiGen: isOnly24 ? 'Wi-Fi 4' : 'Wi-Fi 5',
        has5G: hasRaw('5g')
      });
    }

    const numToken = tokens.find((t) => /^(?:[5-9]|1[0-4]|50|60)[ix]?$/.test(t));
    if (numToken && !modelCodes.some((c) => c !== numToken)) {
      const isNote = hasToken('note');
      const isPro = hasToken('pro');
      const isPlus = hasToken('plus');
      const nVal = parseInt(numToken, 10);
      const isWifi6 = !isNote && nVal >= 11 && isPro;
      const wifiGen = isNote ? 'Wi-Fi 5' : isWifi6 ? 'Wi-Fi 6' : 'Wi-Fi 5';
      const has5G = !isNote && (nVal >= 11 || hasRaw('5g'));
      const suffix = [isPro ? 'Pro' : '', isPlus ? 'Plus' : '', hasRaw('5g') ? '5G' : '']
        .filter(Boolean)
        .join(' ');
      return buildWifiAndCellPayload({
        manufacturer: 'Realme',
        model: `Realme${isNote ? ' Note' : ''} ${numToken.toUpperCase()}${suffix ? ` ${suffix}` : ''}`,
        wifiGen,
        has5G
      });
    }
  }

  // 6. GOOGLE PIXEL (Pixel 3 a Pixel 10, a, Pro, Pro XL, Fold)
  if (hasToken('pixel')) {
    const pixToken = tokens.find((t) => /^(?:[2-9]|10)a?$/.test(t));
    if (pixToken && !modelCodes.some((c) => c !== pixToken)) {
      const numVal = parseInt(pixToken, 10);
      const isA = pixToken.endsWith('a');
      const isPro = hasToken('pro');
      const isXL = hasToken('xl');
      const isFold = hasToken('fold');
      const wifiGen =
        numVal >= 8 && !isA
          ? 'Wi-Fi 7'
          : numVal >= 6
            ? 'Wi-Fi 6E'
            : 'Wi-Fi 5';
      const has5G = numVal >= 5 || hasRaw('5g');
      const suffix = [isPro ? 'Pro' : '', isXL ? 'XL' : '', isFold ? 'Fold' : '']
        .filter(Boolean)
        .join(' ');
      return buildWifiAndCellPayload({
        manufacturer: 'Google',
        model: `Pixel ${pixToken}${suffix ? ` ${suffix}` : ''}`,
        wifiGen,
        has5G
      });
    }
  }

  // 7. INFINIX (Hot, Note, Smart, Zero, GT)
  if (hasToken('infinix')) {
    const infSeries = ['hot', 'note', 'smart', 'zero', 'gt'].find(hasToken);
    const code = modelCodes[0] || '';
    const num = parseInt(code.replace(/\D/g, ''), 10);
    if (infSeries && code && num <= 60) {
      const isPro = hasToken('pro');
      const isPlay = hasToken('play');
      const isOnly24 = infSeries === 'smart';
      const isWifi6 = infSeries === 'gt' || infSeries === 'zero';
      const wifiGen = isOnly24 ? 'Wi-Fi 4' : isWifi6 ? 'Wi-Fi 6' : 'Wi-Fi 5';
      const has5G = infSeries === 'gt' || infSeries === 'zero' || hasRaw('5g');
      const seriesLabel = infSeries === 'gt' ? 'GT' : infSeries[0].toUpperCase() + infSeries.slice(1);
      const suffix = [code.toUpperCase(), isPro ? 'Pro' : '', isPlay ? 'Play' : '', hasRaw('5g') ? '5G' : '']
        .filter(Boolean)
        .join(' ');
      return buildWifiAndCellPayload({
        manufacturer: 'Infinix',
        model: `Infinix ${seriesLabel} ${suffix}`,
        wifiGen,
        has5G
      });
    }
  }

  // 8. ASUS (Zenfone 5..11 Ultra e ROG Phone 2..9 Pro) e ONEPLUS (7..13, Nord)
  if (hasToken('zenfone') || hasToken('rog') || hasToken('asus')) {
    const isRog = hasToken('rog');
    const code = modelCodes[0] || '';
    const num = parseInt(code.replace(/\D/g, ''), 10);
    if (code && num >= 2 && num <= 12) {
      const isUltra = hasToken('ultra');
      const isPro = hasToken('pro');
      const wifiGen = num >= 10 || (isRog && num >= 7) ? 'Wi-Fi 7' : num >= 8 || (isRog && num >= 5) ? 'Wi-Fi 6E' : 'Wi-Fi 6';
      const suffix = [code.toUpperCase(), isUltra ? 'Ultra' : '', isPro ? 'Pro' : ''].filter(Boolean).join(' ');
      return buildWifiAndCellPayload({
        manufacturer: 'Asus',
        model: `${isRog ? 'ROG Phone' : 'Zenfone'} ${suffix}`,
        wifiGen,
        has5G: num >= 7
      });
    }
  }

  if (hasToken('oneplus') || hasToken('nord')) {
    const isNord = hasToken('nord');
    const code = modelCodes[0] || '';
    const num = parseInt(code.replace(/\D/g, ''), 10);
    if (isNord || (code && num >= 5 && num <= 15)) {
      const isPro = hasToken('pro');
      const isCE = hasToken('ce') || /^ce\d*$/i.test(code);
      const wifiGen = !isNord && num >= 11 ? 'Wi-Fi 7' : !isNord && num >= 8 ? 'Wi-Fi 6' : 'Wi-Fi 5';
      const suffix = [isNord ? 'Nord' : '', isCE ? 'CE' : '', code.toUpperCase(), isPro ? 'Pro' : '']
        .filter(Boolean)
        .join(' ');
      return buildWifiAndCellPayload({
        manufacturer: 'OnePlus',
        model: `OnePlus ${suffix}`.replace(/\s+/g, ' ').trim(),
        wifiGen,
        has5G: isNord || num >= 8 || hasRaw('5g')
      });
    }
  }

  // 9. HONOR, OPPO, VIVO / JOVI e NOTHING PHONE
  if (hasToken('honor') || hasToken('magic')) {
    const code = modelCodes[0] || '';
    const num = parseInt(code.replace(/\D/g, ''), 10);
    if (code && num <= 250) {
      const isMagic = hasToken('magic');
      const isLite = hasToken('lite');
      const isPro = hasToken('pro');
      const wifiGen = isMagic && !isLite && num >= 6 ? 'Wi-Fi 7' : !isLite && (isMagic || num >= 70) ? 'Wi-Fi 6' : 'Wi-Fi 5';
      const suffix = [isMagic ? 'Magic' : '', code.toUpperCase(), isPro ? 'Pro' : '', isLite ? 'Lite' : '']
        .filter(Boolean)
        .join(' ');
      return buildWifiAndCellPayload({
        manufacturer: 'Honor',
        model: `Honor ${suffix}`.replace(/\s+/g, ' ').trim(),
        wifiGen,
        has5G: isMagic || num >= 50 || hasRaw('5g')
      });
    }
  }

  if (hasToken('oppo') || hasToken('reno')) {
    const code = modelCodes[0] || '';
    const num = parseInt(code.replace(/\D/g, ''), 10);
    if (code && num <= 120) {
      const isReno = hasToken('reno');
      const isFind = hasToken('find');
      const isPro = hasToken('pro');
      const wifiGen = isFind ? 'Wi-Fi 7' : isReno && isPro ? 'Wi-Fi 6' : 'Wi-Fi 5';
      const suffix = [isReno ? 'Reno' : isFind ? 'Find' : '', code.toUpperCase(), isPro ? 'Pro' : '']
        .filter(Boolean)
        .join(' ');
      return buildWifiAndCellPayload({
        manufacturer: 'Oppo',
        model: `Oppo ${suffix}`.replace(/\s+/g, ' ').trim(),
        wifiGen,
        has5G: isReno || isFind || hasRaw('5g')
      });
    }
  }

  return null;
}

async function searchMediaWikiEndpoint(endpoint, query, queryTokens, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const searchUrl = new URL(endpoint.url);
    searchUrl.searchParams.set('action', 'query');
    searchUrl.searchParams.set('list', 'search');
    searchUrl.searchParams.set('srsearch', query);
    searchUrl.searchParams.set('srlimit', '8');
    searchUrl.searchParams.set('format', 'json');
    searchUrl.searchParams.set('origin', '*');

    const searchResp = await fetchImpl(searchUrl.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    if (!searchResp.ok) return null;
    const searchData = await searchResp.json();
    const hits = Array.isArray(searchData?.query?.search) ? searchData.query.search : [];
    if (hits.length === 0) return null;

    const rankedHits = hits
      .map((h) => ({ title: h.title, score: scoreCandidateTitle(h.title, queryTokens) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    if (rankedHits.length === 0) return null;

    const titlesParam = rankedHits.map((h) => h.title).join('|');
    const pagesUrl = new URL(endpoint.url);
    pagesUrl.searchParams.set('action', 'query');
    pagesUrl.searchParams.set('prop', 'revisions');
    pagesUrl.searchParams.set('rvprop', 'content');
    pagesUrl.searchParams.set('rvslots', 'main');
    pagesUrl.searchParams.set('titles', titlesParam);
    pagesUrl.searchParams.set('format', 'json');
    pagesUrl.searchParams.set('origin', '*');

    const pagesResp = await fetchImpl(pagesUrl.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    if (!pagesResp.ok) return null;
    const pagesData = await pagesResp.json();
    const pagesObj = pagesData?.query?.pages || {};
    const pagesList = Object.values(pagesObj).filter((p) => !p.missing);

    const orderedPages = rankedHits
      .map((r) => pagesList.find((p) => p.title.toLowerCase() === r.title.toLowerCase()))
      .filter(Boolean);

    const requestedVariantTokens = queryTokens.filter((qt) => GROUPABLE_VARIANT_TOKENS.has(qt));

    for (const page of orderedPages) {
      const wikitext =
        page?.revisions?.[0]?.slots?.main?.['*'] || page?.revisions?.[0]?.['*'] || '';
      if (!wikitext) continue;

      const isPhoneArticle =
        /(?:infobox\s+(?:mobile\s+phone|telephone|smartphone|information\s+appliance)|info\/(?:celular|telemóvel|telemovel))/i.test(
          wikitext
        ) ||
        (/\b(?:802\.11|wi-?fi\s*[4567]|wlan)\b/i.test(wikitext) &&
          /\b(?:lte|5g|4g|3g|gsm|smartphone|celular|telemóvel|android|ios|chipset|snapdragon|exynos|dimensity|bionic)\b/i.test(
            wikitext
          ));

      if (!isPhoneArticle) continue;

      // Se o usuário pediu uma variante específica (ex.: Ultra, Pro Max, Mini, Power, Fusion) e o artigo da Wikipedia
      // é o artigo base da família, confirma se a variante realmente consta no artigo
      const pageTitleTokens = normalizeTokens(page.title);
      const missingVariantsInTitle = requestedVariantTokens.filter((t) => !pageTitleTokens.includes(t));
      if (missingVariantsInTitle.length > 0) {
        const bodyTokens = new Set(normalizeTokens(wikitext.slice(0, 14000)));
        if (missingVariantsInTitle.some((t) => !bodyTokens.has(t))) {
          continue;
        }
      }

      const rawManufacturer = extractInfoboxField(wikitext, [
        'manufacturer',
        'fabricante',
        'brand',
        'marca'
      ]);
      const rawName = extractInfoboxField(wikitext, ['name', 'nome']) || page.title;
      // Evita títulos poluídos com múltiplos submodelos separados por vírgula
      const primaryDisplayName = rawName.includes(',') ? page.title : rawName;

      const infoboxConn = extractInfoboxField(wikitext, [
        'connectivity',
        'conectividade',
        'wlan',
        'wifi',
        'wi-fi',
        'wireless',
        'data',
        'dados',
        'communications'
      ]);
      const infoboxNet = extractInfoboxField(wikitext, [
        'networks',
        'network',
        'redes',
        'rede',
        'cellular',
        'celular',
        'bandas',
        'bands'
      ]);
      const released = cleanReleasedLabel(
        extractInfoboxField(wikitext, ['released', 'lancamento', 'lançamento'])
      );
      if (isPre2015ReleaseDate(released) || isPre2015DeviceQuery(page.title)) {
        continue;
      }
      const chipset = extractInfoboxField(wikitext, [
        'soc',
        'chipset',
        'cpu',
        'processor',
        'processador'
      ]);
      const ram = extractInfoboxField(wikitext, ['memory', 'ram', 'memoria', 'memória']);

      const fallbackSpecs = extractArticleFallbackSpecs(wikitext);
      const combinedConnectivity = [infoboxConn, fallbackSpecs.wifiText].filter(Boolean).join(', ');
      const combinedNetworks = [infoboxNet, fallbackSpecs.netText].filter(Boolean).join(', ');

      const knownBrands = [
        'Samsung',
        'Apple',
        'Motorola',
        'Xiaomi',
        'Redmi',
        'POCO',
        'Realme',
        'Infinix',
        'Asus',
        'LG',
        'Nokia',
        'OnePlus',
        'Google',
        'Huawei',
        'Honor',
        'Oppo',
        'Vivo'
      ];

      const detectedBrand =
        knownBrands.find((b) =>
          `${rawManufacturer} ${primaryDisplayName} ${page.title}`
            .toLowerCase()
            .includes(b.toLowerCase())
        ) ||
        rawManufacturer.split(',')[0] ||
        page.title.split(' ')[0];

      let cleanModel =
        primaryDisplayName
          .replace(/\bseries\b/gi, '')
          .replace(new RegExp(`^${escapeRegExp(detectedBrand)}\\s*`, 'i'), '')
          .replace(/[,;:\s]+$/g, '')
          .trim() || page.title;

      // Se a página agrupa a variante solicitada (ex.: iPhone 16 Pro Max dentro de iPhone 16 Pro), preserva a variante
      if (missingVariantsInTitle.length > 0 || /\bseries\b/i.test(page.title)) {
        const knownSpec = resolveKnownFamilySpecs(query);
        if (knownSpec && knownSpec.model) {
          cleanModel = knownSpec.model;
        }
      }

      const wifi = parseWifiSpecs(combinedConnectivity);
      const cellular = parseCellularSpecs(combinedNetworks, `${page.title} ${primaryDisplayName}`);

      // Se o artigo da Wikipedia não tinha campo de Wi-Fi explícito, enriquece com a base da família
      if (wifi.generation === 'Informação não disponível') {
        const familyFallback = resolveKnownFamilySpecs(`${detectedBrand} ${cleanModel}`);
        if (familyFallback?.wifi) {
          Object.assign(wifi, familyFallback.wifi);
        }
      }

      return normalizeDevicePayload({
        id: `wiki-${page.pageid || page.title}`,
        manufacturer: detectedBrand,
        model: cleanModel,
        regionalVariant: released ? `Lançamento: ${released}` : 'Ficha Técnica Internacional',
        hardware: {
          chipset: chipset || null,
          ram: ram || null
        },
        wifi,
        cellular,
        source: `${endpoint.label} — ${page.title}`,
        dataVersion: new Date().toISOString().slice(0, 10)
      });
    }

    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadGooglePlayRegistry(fetchImpl, registryUrl = GOOGLE_PLAY_DEVICES_CDN) {
  if (googlePlayCatalogPromise) {
    return googlePlayCatalogPromise;
  }

  googlePlayCatalogPromise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const resp = await fetchImpl(registryUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (!resp.ok) return [];
      const rawMap = await resp.json();
      if (!rawMap || typeof rawMap !== 'object') return [];

      const entries = [];
      for (const [code, info] of Object.entries(rawMap)) {
        if (!info || typeof info !== 'object') continue;
        const brand = String(info.brand || '').trim();
        const rawName = String(info.name || '').trim();
        if (!brand && !rawName) continue;

        const fullName = rawName.toLowerCase().startsWith(brand.toLowerCase())
          ? rawName
          : `${brand} ${rawName}`.trim();

        const cleanNameWithoutParens = rawName.replace(/\([^)]*\)/g, ' ').trim() || rawName;

        entries.push({
          code: String(code).trim(),
          brand: brand || fullName.split(' ')[0],
          model: rawName.replace(new RegExp(`^${escapeRegExp(brand)}\\s*`, 'i'), '').trim() || rawName || code,
          fullName,
          nameTokens: normalizeTokens(`${brand} ${cleanNameWithoutParens}`),
          tokens: normalizeTokens(`${brand} ${rawName} ${code}`)
        });
      }
      return entries;
    } catch {
      googlePlayCatalogPromise = null;
      return [];
    } finally {
      clearTimeout(timer);
    }
  })();

  return googlePlayCatalogPromise;
}

async function searchGooglePlayRegistry(query, queryTokens, fetchImpl, registryUrl) {
  if (queryTokens.length === 0) return null;
  const entries = await loadGooglePlayRegistry(fetchImpl, registryUrl);
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const coreQueryTokens = queryTokens.filter((t) => !ACCESSORY_NOISE_TOKENS.has(t));
  const effectiveQueryTokens = coreQueryTokens.length > 0 ? coreQueryTokens : queryTokens;
  const normalizedFullQuery = effectiveQueryTokens.join(' ');
  const isSkuQuery =
    /^(?:sm-[a-z0-9-]+|xt\d{3,}[a-z0-9-]*|rmx\d{3,}[a-z0-9-]*|cph\d{3,}[a-z0-9-]*|[a-z]{1,4}\d{3,}-\d+[a-z0-9-]*)$/i.test(
      String(query || '').trim()
    );
  const queryModelCodes = extractModelCodeTokens(effectiveQueryTokens);
  const matches = [];

  for (const item of entries) {
    if (isPre2015DeviceQuery(item.fullName)) continue;
    const nameTokens = item.nameTokens || normalizeTokens(`${item.brand} ${item.model}`);

    // Quando a busca especifica um código/número de modelo (ex.: A15, G84, E22, 13C) e não é um SKU puro,
    // exige casamento exato dos tokens numéricos e dos modificadores de variante para nunca trocar modelos.
    if (!isSkuQuery && queryModelCodes.length > 0) {
      let exactModelMatch = true;
      for (const code of queryModelCodes) {
        if (!item.tokens.includes(code)) {
          exactModelMatch = false;
          break;
        }
      }
      if (!exactModelMatch) continue;

      const itemModelCodes = extractModelCodeTokens(nameTokens);
      if (itemModelCodes.some((ic) => !queryModelCodes.includes(ic))) {
        continue;
      }

      let variantMismatch = false;
      for (const sub of SUBFAMILY_TOKENS) {
        if (effectiveQueryTokens.includes(sub) !== nameTokens.includes(sub)) {
          variantMismatch = true;
          break;
        }
      }
      if (variantMismatch) continue;

      for (const ed of STRICT_EDITION_TOKENS) {
        if (effectiveQueryTokens.includes(ed) !== nameTokens.includes(ed)) {
          variantMismatch = true;
          break;
        }
      }
      if (variantMismatch) continue;

      for (const variant of GROUPABLE_VARIANT_TOKENS) {
        if (effectiveQueryTokens.includes(variant) !== nameTokens.includes(variant)) {
          variantMismatch = true;
          break;
        }
      }
      if (variantMismatch) continue;
    }

    let score = 0;
    let allTokensMatched = true;

    for (const qt of effectiveQueryTokens) {
      if (item.tokens.includes(qt)) {
        score += 3;
      } else if (
        // Permite equivalência de submarca Xiaomi/Redmi/POCO ou Motorola/Moto quando o registro omite uma delas
        (qt === 'xiaomi' && (item.tokens.includes('redmi') || item.tokens.includes('poco'))) ||
        (qt === 'galaxy' && item.tokens.includes('samsung')) ||
        (qt === 'moto' && item.tokens.includes('motorola'))
      ) {
        score += 2;
      } else if (
        !queryModelCodes.includes(qt) &&
        item.tokens.some((t) => t.startsWith(qt) || (qt.length >= 3 && t.includes(qt)))
      ) {
        score += 1;
      } else {
        allTokensMatched = false;
        break;
      }
    }

    if (!allTokensMatched) continue;

    if (
      nameTokens.join(' ') === normalizedFullQuery ||
      item.tokens.join(' ') === normalizedFullQuery ||
      item.code.toLowerCase() === normalizedFullQuery
    ) {
      score += 6;
    }
    score -= item.tokens.length * 0.12;
    matches.push({ item, score });
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.score - a.score);

  const best = matches[0].item;
  const siblingCodes = [
    ...new Set(
      matches
        .filter(
          (m) =>
            m.item.brand.toLowerCase() === best.brand.toLowerCase() &&
            m.item.model.toLowerCase() === best.model.toLowerCase()
        )
        .map((m) => m.item.code)
    )
  ].slice(0, 6);

  const familySpecs = resolveKnownFamilySpecs(`${best.brand} ${best.model}`);
  const has5G = familySpecs
    ? Boolean(familySpecs.cellular?.has5G)
    : /\b5g\b/i.test(`${best.model} ${best.fullName}`);

  return normalizeDevicePayload({
    id: `gplay-${best.code.toLowerCase()}`,
    manufacturer: best.brand,
    model: best.model,
    regionalVariant:
      siblingCodes.length > 0
        ? `Códigos homologados Google Play: ${siblingCodes.join(', ')}`
        : 'Dispositivo Certificado Google Play',
    hardware: familySpecs?.hardware || { chipset: null, ram: null },
    wifi: {
      generation: familySpecs?.wifi?.generation || 'Informação não disponível',
      standards: familySpecs?.wifi?.standards || 'Informação não disponível',
      bands: familySpecs?.wifi?.bands || [],
      supports6Ghz: Boolean(familySpecs?.wifi?.supports6Ghz),
      channelWidthsMhz: null,
      mimo: null,
      theoreticalLinkMbps: null,
      favorableRangeMbps: null
    },
    cellular: {
      has4G: true,
      has5G,
      generations: has5G ? ['4G LTE', '5G'] : ['4G LTE'],
      lteCategory: null,
      carrierAggregation: null,
      bands5G: [],
      bands4G: [],
      theoreticalDownMbps: null,
      theoreticalUpMbps: null
    },
    source: 'Google Play Certified Devices Registry (Online)',
    dataVersion: new Date().toISOString().slice(0, 10)
  });
}

/**
 * Expande entradas compactas, sem espacos ou em minusculas (Postel's law)
 * preservando codigos de modelo/SKU intactos (ex.: SM-A065M, XT2239-10).
 *
 * @param {string} rawQuery
 * @returns {string}
 */
export function expandTolerantDeviceQuery(rawQuery) {
  const cleaned = sanitizeDeviceQuery(rawQuery);
  if (!cleaned) return '';

  // Preserva códigos/SKU de fabricante intactos (SM-A065M, XT2239-10, RMX3771 etc.)
  if (
    /^(?:sm-[a-z0-9-]+|xt\d{3,}[a-z0-9-]*|rmx\d{3,}[a-z0-9-]*|cph\d{3,}[a-z0-9-]*|[a-z]{1,4}\d{3,}-\d+[a-z0-9-]*)$/i.test(
      cleaned
    ) ||
    /\b(?:sm-[a-z0-9-]+|xt\d{3,}[a-z0-9-]*)\b/i.test(cleaned)
  ) {
    return cleaned;
  }

  let normalized = cleaned
    .replace(/(\d|\bpro)\s*\+/gi, '$1 Plus ')
    .replace(/[_/]+/g, ' ')
    .replace(/-(?![a-z0-9]*\d{3,})/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Separa prefixos de linha/marca colados sem espaço
  normalized = normalized
    .replace(/\biphone(?=[a-z0-9])/gi, 'iPhone ')
    .replace(/\bipad(pro|air|mini)?(\d+[a-z0-9]*)?/gi, (_, tier, num) =>
      ['iPad', tier, num].filter(Boolean).join(' ')
    )
    .replace(/\bgalaxy([a-z0-9]+)/gi, 'Galaxy $1')
    .replace(/\bmoto([egxz]\d[a-z0-9]*)/gi, 'Moto $1')
    .replace(/\bedge(\d[a-z0-9]*)/gi, 'Edge $1')
    .replace(/\brazr(\d[a-z0-9]*)/gi, 'Razr $1')
    .replace(/\bredmi(note)?(\d[a-z0-9]*)/gi, (_, note, rest) =>
      ['Redmi', note, rest].filter(Boolean).join(' ')
    )
    .replace(/\bpoco([a-z]\d[a-z0-9]*)/gi, 'Poco $1')
    .replace(/\brealme([a-z0-9]+)/gi, 'Realme $1')
    .replace(/\bpixel(\d[a-z0-9]*)/gi, 'Pixel $1')
    .replace(/\bzenfone(\d[a-z0-9]*)/gi, 'Zenfone $1')
    .replace(/\b(?:z\s*)?(flip|fold)(\d[a-z0-9]*)/gi, 'Z $1 $2');

  // Junta letra de série separada por espaço do número (ex.: "Galaxy A 15" -> "Galaxy A15", "Moto G 84" -> "Moto G84")
  normalized = normalized
    .replace(/\b(galaxy\s+[samfj])\s+(\d{1,2}[a-z]?)\b/gi, '$1$2')
    .replace(/\b(samsung\s+[samfj])\s+(\d{1,2}[a-z]?)\b/gi, '$1$2')
    .replace(/\b(moto(?:rola)?\s+[eg])\s+(\d{1,3}[a-z]?)\b/gi, '$1$2')
    .replace(/\b(poco\s+[cmxf])\s+(\d{1,2}[a-z]?)\b/gi, '$1$2')
    .replace(/\b(realme\s+c)\s+(\d{1,2}[a-z]?)\b/gi, '$1$2');

  // Separa sufixos comerciais colados ao número do modelo
  normalized = normalized
    .replace(
      /(\d)(?=(?:promax|pro|ultra|plus|mini|lite|neo|fe|fusion|max|air|play|power|prime|stylus)(?:5g|4g)?(?:\s|$))/gi,
      '$1 '
    )
    .replace(/\bpromax\b/gi, 'Pro Max')
    .replace(
      /\b(pro|ultra|plus|mini|lite|neo|fe|fusion|max|air|play|power|prime|stylus)(5g|4g)\b/gi,
      '$1 $2'
    )
    .replace(/\s+/g, ' ')
    .trim();

  // Normaliza caixa dos sufixos comerciais comuns
  normalized = normalized
    .replace(/\biphone\b/gi, 'iPhone')
    .replace(/\bipad\b/gi, 'iPad')
    .replace(/\bgalaxy\b/gi, 'Galaxy')
    .replace(/\bmoto\b/gi, 'Moto')
    .replace(/\bedge\b/gi, 'Edge')
    .replace(/\brazr\b/gi, 'Razr')
    .replace(/\bredmi\b/gi, 'Redmi')
    .replace(/\bpoco\b/gi, 'Poco')
    .replace(/\brealme\b/gi, 'Realme')
    .replace(/\bpixel\b/gi, 'Pixel')
    .replace(/\bzenfone\b/gi, 'Zenfone')
    .replace(/\binfinix\b/gi, 'Infinix')
    .replace(/\bnote\b/gi, 'Note')
    .replace(/\bpro\b/gi, 'Pro')
    .replace(/\bmax\b/gi, 'Max')
    .replace(/\bultra\b/gi, 'Ultra')
    .replace(/\bplus\b/gi, 'Plus')
    .replace(/\bmini\b/gi, 'Mini')
    .replace(/\blite\b/gi, 'Lite')
    .replace(/\bneo\b/gi, 'Neo')
    .replace(/\bfusion\b/gi, 'Fusion')
    .replace(/\bfe\b/gi, 'FE')
    .replace(/\b5g\b/gi, '5G')
    .replace(/\b4g\b/gi, '4G')
    .replace(/\b([a-z])(\d+[a-z]?)\b/gi, (_, letter, rest) => `${letter.toUpperCase()}${rest}`);

  // Completa linha omitida quando o usuário digita apenas a marca + código (ex.: "Samsung A54" -> "Samsung Galaxy A54", "Motorola G84" -> "Motorola Moto G84")
  normalized = normalized
    .replace(/^samsung\s+(?=(?:[AMFS]\d{1,2}[a-z]?|J[1-8]|Z\s+(?:Flip|Fold))\b)/i, 'Samsung Galaxy ')
    .replace(/^motorola\s+(?=[EG]\d{1,3}[a-z]?\b)/i, 'Motorola Moto ');

  // Expande códigos curtos sem marca (ex.: "a10", "a71", "m54", "s25 fe", "e22", "g84", "note 13 pro", "x6 pro")
  if (
    /^(?:s(?:[6-9]|10|2\d)e?(?:\s+(?:FE|Plus|Ultra|Edge|Lite|5G|4G))*|[amf]\d{1,2}[se]?(?:\s+(?:Core|5G|4G))*|j[1-8](?:\s+(?:Prime|Pro|Core|Neo|Plus))*)$/i.test(
      normalized
    )
  ) {
    return `Galaxy ${normalized
      .toUpperCase()
      .replace(/\b([AMFS]\d+)([SE])\b/g, '$1$2')
      .replace(/\b([AMFS]\d+)S\b/g, '$1s')
      .replace(/\b([AMFS]\d+)E\b/g, '$1e')
      .replace(/\bPLUS\b/g, 'Plus')
      .replace(/\bULTRA\b/g, 'Ultra')
      .replace(/\bEDGE\b/g, 'Edge')
      .replace(/\bLITE\b/g, 'Lite')
      .replace(/\bCORE\b/g, 'Core')
      .replace(/\bPRIME\b/g, 'Prime')
      .replace(/\bPRO\b/g, 'Pro')
      .replace(/\bNEO\b/g, 'Neo')}`;
  }
  if (
    /^(?:e\d{1,2}[is]?|g\d{1,3}s?)(?:\s+(?:Play|Power|Plus|Stylus|Lite|5G|4G))*$/i.test(
      normalized
    )
  ) {
    return `Moto ${normalized
      .toUpperCase()
      .replace(/\b(E\d+)I\b/g, '$1i')
      .replace(/\b([EG]\d+)S\b/g, '$1s')
      .replace(/\bPLAY\b/g, 'Play')
      .replace(/\bPOWER\b/g, 'Power')
      .replace(/\bPLUS\b/g, 'Plus')
      .replace(/\bSTYLUS\b/g, 'Stylus')
      .replace(/\bLITE\b/g, 'Lite')}`;
  }
  if (/^Z\s+(?:Flip|Fold)(?:\s+\d+)?/i.test(normalized)) {
    return `Galaxy ${normalized.replace(/\b(flip|fold)\b/gi, (m) => m[0].toUpperCase() + m.slice(1).toLowerCase())}`;
  }
  if (/^Note\s+(?:[7-9]|1[0-4])\b/i.test(normalized) && !/\b(?:Ultra|Lite)\b/i.test(normalized)) {
    return `Redmi ${normalized}`;
  }
  if (/^(?:X[3-7]|F[3-7]|C[567]5)(?:\s+(?:Pro|GT|Neo|Ultra|5G|4G))*$/i.test(normalized)) {
    return `Poco ${normalized}`;
  }

  return normalized;
}

export class DeviceSpecsService {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.googlePlayRegistryUrl = options.googlePlayRegistryUrl || GOOGLE_PLAY_DEVICES_CDN;
    this.sessionCache = new Map();
  }

  getSupportedBrands() {
    return SUPPORTED_DEVICE_BRANDS.slice();
  }

  getBrandSuggestions(brandId, rawInput = '', limit = 10) {
    return getBrandModelSuggestions(brandId, rawInput, limit);
  }

  getPopularModels() {
    return [
      { manufacturer: 'Samsung', model: 'Galaxy A10' },
      { manufacturer: 'Samsung', model: 'Galaxy A06' },
      { manufacturer: 'Motorola', model: 'Moto E22' },
      { manufacturer: 'Samsung', model: 'Galaxy A71' },
      { manufacturer: 'Samsung', model: 'Galaxy S25 FE' },
      { manufacturer: 'Apple', model: 'iPhone 16' }
    ];
  }

  async lookupDevice(rawQuery, options = {}) {
    const brandId = options?.brandId || null;
    const scopedRaw = brandId ? scopeQueryToBrand(rawQuery, brandId) : rawQuery;
    const query = expandTolerantDeviceQuery(scopedRaw);
    if (!query) {
      return {
        status: 'empty',
        device: null,
        origin: 'none',
        message: 'Informe o fabricante e o modelo do aparelho (ex.: Galaxy A10, A06, A71, S25 FE).'
      };
    }

    if (isPre2015DeviceQuery(query)) {
      return {
        status: 'not-found',
        device: null,
        origin: 'temporal-filter-2015-2026',
        message: `O modelo "${query}" é anterior a 2015. A consulta é parametrizada exclusivamente para aparelhos lançados entre 2015 e 2026.`
      };
    }

    if (!this.fetchImpl) {
      return {
        status: 'error',
        device: null,
        origin: 'none',
        message: 'Ambiente sem suporte a requisições HTTP online.'
      };
    }

    const queryTokens = normalizeTokens(query);
    const cacheKey = queryTokens.slice().sort().join(' ');
    if (this.sessionCache.has(cacheKey)) {
      return this.sessionCache.get(cacheKey);
    }

    // 1. Wikipedia Online (Infobox desembrulhado + validação estrita de modelo)
    try {
      for (const endpoint of WIKI_ENDPOINTS) {
        const foundDevice = await searchMediaWikiEndpoint(
          endpoint,
          query,
          queryTokens,
          this.fetchImpl
        );
        if (foundDevice) {
          const payload = {
            status: 'found',
            device: foundDevice,
            origin: 'wikipedia-online',
            message: null
          };
          this.sessionCache.set(cacheKey, payload);
          return payload;
        }
      }
    } catch {
      // Segue para o registro oficial do Google Play
    }

    let hadNetworkError = false;

    // 2. Google Play Certified Devices Registry (30.000+ modelos com filtro estrito de variante)
    try {
      const registryDevice = await searchGooglePlayRegistry(
        query,
        queryTokens,
        this.fetchImpl,
        this.googlePlayRegistryUrl
      );
      if (registryDevice) {
        const payload = {
          status: 'found',
          device: registryDevice,
          origin: 'google-play-registry',
          message: null
        };
        this.sessionCache.set(cacheKey, payload);
        return payload;
      }
    } catch {
      hadNetworkError = true;
    }

    // 3. Base Determinística de Famílias e Gerações Conhecidas (2015–2026)
    const familySpec = resolveKnownFamilySpecs(query);
    if (familySpec) {
      const synthesized = normalizeDevicePayload({
        id: `catalog-${familySpec.manufacturer}-${familySpec.model}`,
        manufacturer: familySpec.manufacturer,
        model: familySpec.model,
        regionalVariant: 'Especificação de Referência da Linha Comercial',
        hardware: familySpec.hardware,
        wifi: familySpec.wifi,
        cellular: familySpec.cellular,
        source: `Base Técnica de Famílias Homologadas — ${familySpec.manufacturer} ${familySpec.model}`,
        dataVersion: new Date().toISOString().slice(0, 10)
      });
      if (synthesized) {
        const payload = {
          status: 'found',
          device: synthesized,
          origin: 'catalog-reference',
          message: null
        };
        this.sessionCache.set(cacheKey, payload);
        return payload;
      }
    }

    if (hadNetworkError) {
      return {
        status: 'error',
        device: null,
        origin: 'online',
        message: 'Falha de rede durante a consulta online. Verifique sua conexão e tente novamente.'
      };
    }

    return {
      status: 'not-found',
      device: null,
      origin: 'online',
      message: `Nenhum aparelho encontrado para "${query}". Verifique a grafia do modelo ou informe o código homologado (ex.: SM-A065M).`
    };
  }
}