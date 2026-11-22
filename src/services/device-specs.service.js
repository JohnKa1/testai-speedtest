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
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
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
  const titleTokens = normalizeTokens(title);
  if (titleTokens.length === 0) return -1;

  let matched = 0;
  for (const qt of queryTokens) {
    if (titleTokens.includes(qt)) {
      matched += 2;
    } else if (titleTokens.some((tt) => tt.startsWith(qt) || qt.startsWith(tt))) {
      matched += 1;
    }
  }

  const listPenalty = /^list of|^lista de/i.test(title) ? -5 : 0;
  return matched + listPenalty - titleTokens.length * 0.05;
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

    for (const page of orderedPages) {
      const wikitext =
        page?.revisions?.[0]?.slots?.main?.['*'] || page?.revisions?.[0]?.['*'] || '';
      if (!wikitext) continue;

      const isPhoneArticle =
        /infobox\s+(?:mobile\s+phone|telephone|smartphone|info\/celular)/i.test(wikitext) ||
        (/802\.11/i.test(wikitext) && /\b(?:lte|5g|smartphone|android|ios)\b/i.test(wikitext));

      if (!isPhoneArticle) continue;

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
        'Asus',
        'LG',
        'Nokia',
        'OnePlus',
        'Google',
        'Huawei'
      ];

      const detectedBrand =
        knownBrands.find((b) =>
          `${rawManufacturer} ${primaryDisplayName} ${page.title}`
            .toLowerCase()
            .includes(b.toLowerCase())
        ) ||
        rawManufacturer.split(',')[0] ||
        page.title.split(' ')[0];

      const cleanModel =
        primaryDisplayName
          .replace(new RegExp(`^${escapeRegExp(detectedBrand)}\\s*`, 'i'), '')
          .replace(/[,;:\s]+$/g, '')
          .trim() || page.title;

      const wifi = parseWifiSpecs(combinedConnectivity);
      const cellular = parseCellularSpecs(combinedNetworks, `${page.title} ${primaryDisplayName}`);

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

        entries.push({
          code: String(code).trim(),
          brand: brand || fullName.split(' ')[0],
          model: rawName.replace(new RegExp(`^${escapeRegExp(brand)}\\s*`, 'i'), '').trim() || rawName || code,
          fullName,
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

  const normalizedFullQuery = queryTokens.join(' ');
  const matches = [];

  for (const item of entries) {
    let score = 0;
    let allTokensMatched = true;

    for (const qt of queryTokens) {
      if (item.tokens.includes(qt)) {
        score += 3;
      } else if (item.tokens.some((t) => t.startsWith(qt) || (qt.length >= 3 && t.includes(qt)))) {
        score += 1;
      } else {
        allTokensMatched = false;
        break;
      }
    }

    if (!allTokensMatched) continue;

    if (item.tokens.join(' ') === normalizedFullQuery || item.code.toLowerCase() === normalizedFullQuery) {
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

  const has5G = /\b5g\b/i.test(`${best.model} ${best.fullName}`);

  return normalizeDevicePayload({
    id: `gplay-${best.code.toLowerCase()}`,
    manufacturer: best.brand,
    model: best.model,
    regionalVariant:
      siblingCodes.length > 0
        ? `Códigos homologados Google Play: ${siblingCodes.join(', ')}`
        : 'Dispositivo Certificado Google Play',
    wifi: {
      generation: 'Informação não disponível',
      standards: 'Informação não disponível',
      bands: [],
      supports6Ghz: false,
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
    .replace(/\bredmi(note)?(\d[a-z0-9]*)/gi, (_, note, rest) =>
      ['Redmi', note, rest].filter(Boolean).join(' ')
    )
    .replace(/\bpoco([a-z]\d[a-z0-9]*)/gi, 'Poco $1')
    .replace(/\bpixel(\d[a-z0-9]*)/gi, 'Pixel $1')
    .replace(/\bz(flip|fold)(\d[a-z0-9]*)/gi, 'Z $1 $2');

  // Separa sufixos comerciais colados ao número do modelo
  normalized = normalized
    .replace(
      /(\d)(?=(?:promax|pro|ultra|plus|mini|lite|neo|fe|fusion|max|air|play|power|prime)(?:5g|4g)?(?:\s|$))/gi,
      '$1 '
    )
    .replace(/\bpromax\b/gi, 'Pro Max')
    .replace(
      /\b(pro|ultra|plus|mini|lite|neo|fe|fusion|max|air|play|power|prime)(5g|4g)\b/gi,
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
    .replace(/\bredmi\b/gi, 'Redmi')
    .replace(/\bpoco\b/gi, 'Poco')
    .replace(/\bpixel\b/gi, 'Pixel')
    .replace(/\bnote\b/gi, 'Note')
    .replace(/\bpro\b/gi, 'Pro')
    .replace(/\bmax\b/gi, 'Max')
    .replace(/\bultra\b/gi, 'Ultra')
    .replace(/\bplus\b/gi, 'Plus')
    .replace(/\bmini\b/gi, 'Mini')
    .replace(/\blite\b/gi, 'Lite')
    .replace(/\bneo\b/gi, 'Neo')
    .replace(/\bfe\b/gi, 'FE')
    .replace(/\b5g\b/gi, '5G')
    .replace(/\b4g\b/gi, '4G')
    .replace(/\b([a-z])(\d+[a-z]?)\b/gi, (_, letter, rest) => `${letter.toUpperCase()}${rest}`);

  // Expande códigos curtos de 1 token (ex.: "a10", "s25 fe", "e22", "g84")
  if (/^(?:s2\d(?:\s+(?:FE|Plus|Ultra|Edge|5G))?|a0[56]|a1\d|a2\d|a3\d|a5\d)$/i.test(normalized)) {
    return `Galaxy ${normalized.toUpperCase().replace(/\bPLUS\b/g, 'Plus').replace(/\bULTRA\b/g, 'Ultra').replace(/\bEDGE\b/g, 'Edge')}`;
  }
  if (/^(?:e1[34]|e2[02]|e32|g24|g34|g54|g84)$/i.test(normalized)) {
    return `Moto ${normalized.toUpperCase()}`;
  }
  if (/^Z\s+(?:Flip|Fold)\s+\d+/i.test(normalized)) {
    return `Galaxy ${normalized.replace(/\b(flip|fold)\b/gi, (m) => m[0].toUpperCase() + m.slice(1).toLowerCase())}`;
  }

  return normalized;
}

export class DeviceSpecsService {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.googlePlayRegistryUrl = options.googlePlayRegistryUrl || GOOGLE_PLAY_DEVICES_CDN;
    this.sessionCache = new Map();
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

  async lookupDevice(rawQuery) {
    const query = expandTolerantDeviceQuery(rawQuery);
    if (!query) {
      return {
        status: 'empty',
        device: null,
        origin: 'none',
        message: 'Informe o fabricante e o modelo do aparelho (ex.: Galaxy A10, A06, A71, S25 FE).'
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

    // 1. Wikipedia Online (Infobox desembrulhado + texto técnico do artigo)
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

    // 2. Google Play Certified Devices Registry (30.000+ modelos: antigos, regionais e de entrada)
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