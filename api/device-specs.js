import fs from 'node:fs';
import path from 'node:path';

const CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const memoryCache = new Map();

function loadMobileApiKey() {
  if (process.env.MOBILEAPI_KEY) {
    const k = String(process.env.MOBILEAPI_KEY).trim().replace(/^["']|["']$/g, '');
    if (k && k !== 'COLE_SUA_CHAVE_AQUI') return k;
  }
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*MOBILEAPI_KEY\s*=\s*(.+)\s*$/);
        if (match) {
          const k = match[1].trim().replace(/^["']|["']$/g, '');
          if (k && k !== 'COLE_SUA_CHAVE_AQUI') return k;
        }
      }
    }
  } catch {
    // Ignora em ambientes serverless sem filesystem
  }
  return '';
}

function sanitizeQuery(raw) {
  return String(raw ?? '')
    .replace(/[<>"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function sendJson(res, statusCode, payload, cacheable = false) {
  if (cacheable) {
    res.setHeader('Cache-Control', 'public, s-maxage=43200, stale-while-revalidate=86400');
  }
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(statusCode).json(payload);
  }
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function parseWifiGeneration(wifiText) {
  const txt = String(wifiText || '');
  if (/802\.11\s*[a-z/]*be\b|wi-?fi\s*7\b/i.test(txt)) return 'Wi-Fi 7';
  if (/wi-?fi\s*6e\b|6\s*ghz/i.test(txt)) return 'Wi-Fi 6E';
  if (/802\.11\s*[a-z/]*ax\b|wi-?fi\s*6\b/i.test(txt)) return 'Wi-Fi 6';
  if (/802\.11\s*[a-z/]*ac\b|wi-?fi\s*5\b/i.test(txt)) return 'Wi-Fi 5';
  if (/802\.11\s*[a-z/]*n\b|wi-?fi\s*4\b/i.test(txt)) return 'Wi-Fi 4';
  if (/802\.11\s*[bg]/i.test(txt)) return 'Wi-Fi 3 (802.11b/g)';
  return null;
}

function parseWifiBands(wifiText, generation) {
  const txt = String(wifiText || '');
  const bands = [];
  const supports6Ghz =
    generation === 'Wi-Fi 6E' ||
    generation === 'Wi-Fi 7' ||
    /tri-?band|6\s*ghz/i.test(txt);

  if (txt) {
    if (/2\.4\s*ghz|dual-?band|tri-?band|802\.11/i.test(txt)) bands.push('2,4 GHz');
    if (
      /5\s*ghz|dual-?band|tri-?band|802\.11\s*[a-z/]*(?:a|ac|ax|be)\b/i.test(txt) ||
      ['Wi-Fi 5', 'Wi-Fi 6', 'Wi-Fi 6E', 'Wi-Fi 7'].includes(generation)
    ) {
      bands.push('5 GHz');
    }
    if (supports6Ghz) bands.push('6 GHz');
  }
  return [...new Set(bands)];
}

function extractBandsList(rawText) {
  return String(rawText || '')
    .split(/[,;/|]/)
    .map((s) => s.trim())
    .filter((s) => s && s.length <= 24);
}

function extractItemsArray(data) {
  if (Array.isArray(data?.devices)) return data.devices;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && (data.name || data.model)) return [data];
  return [];
}

async function fetchFromMobileApi(baseUrl, mobileApiKey) {
  // MobileAPI.dev pode autenticar via Bearer, Token ou query param ?key=
  // 1. Authorization: Bearer <key>
  let resp = await fetch(baseUrl.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${mobileApiKey}`
    }
  }).catch(() => null);

  // 2. Authorization: Token <key>
  if (!resp || resp.status === 401 || resp.status === 403) {
    resp = await fetch(baseUrl.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Token ${mobileApiKey}`
      }
    }).catch(() => null);
  }

  // 3. Query param ?key=
  if (!resp || resp.status === 401 || resp.status === 403) {
    const urlWithKey = new URL(baseUrl.toString());
    urlWithKey.searchParams.set('key', mobileApiKey);
    resp = await fetch(urlWithKey.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' }
    }).catch(() => null);
  }

  // 4. Header X-API-Key
  if (!resp || resp.status === 401 || resp.status === 403) {
    resp = await fetch(baseUrl.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-API-Key': mobileApiKey
      }
    }).catch(() => null);
  }

  return resp;
}

export async function handler(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const parsedUrl = new URL(req.url || '', 'http://localhost');
  const rawQ = req.query?.q ?? parsedUrl.searchParams.get('q');
  const query = sanitizeQuery(rawQ);

  if (!query || query.length < 2) {
    return sendJson(res, 400, { error: 'Consulta inválida' });
  }

  const cacheKey = query.toLowerCase();
  const cached = memoryCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return sendJson(res, 200, cached.payload, true);
  }

  const mobileApiKey = loadMobileApiKey();
  if (!mobileApiKey) {
    return sendJson(res, 503, { error: 'MOBILEAPI_KEY não configurada no servidor' });
  }

  try {
    const searchUrl = new URL('https://api.mobileapi.dev/devices/search/');
    searchUrl.searchParams.set('name', query);

    const resp = await fetchFromMobileApi(searchUrl, mobileApiKey);
    if (!resp) {
      return sendJson(res, 502, { error: 'Falha de conexão com MobileAPI.dev' });
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.warn(`[TestAi /api/device-specs] MobileAPI HTTP ${resp.status}: ${errText.slice(0, 140)}`);
      return sendJson(res, 502, { error: `Falha ao consultar MobileAPI.dev (HTTP ${resp.status})` });
    }

    const data = await resp.json();
    const list = extractItemsArray(data);
    let item = list.find((d) => d && (d.name || d.model));

    if (!item) {
      return sendJson(res, 404, { error: 'Dispositivo não encontrado na MobileAPI.dev' });
    }

    const hasCommsInHit = Boolean(
      item.wlan || item.comms || item.communications || item.specifications || item['4g_bands']
    );
    if (!hasCommsInHit && item.id) {
      const detailUrl = new URL(`https://api.mobileapi.dev/devices/${encodeURIComponent(item.id)}/`);
      const detailResp = await fetchFromMobileApi(detailUrl, mobileApiKey);
      if (detailResp && detailResp.ok) {
        const detailData = await detailResp.json();
        const detailObj = detailData?.device || detailData?.data || detailData;
        if (detailObj && typeof detailObj === 'object') {
          item = { ...item, ...detailObj };
        }
      }
    }

    const comms = item.comms || item.communications || item.specifications?.comms || {};
    const net = item.network || item.specifications?.network || {};

    const wifiRaw = String(
      item.wlan || comms.wlan || item.wifi || comms.wifi || item.connectivity || ''
    ).trim();
    const generation = parseWifiGeneration(wifiRaw);
    const bands = parseWifiBands(wifiRaw, generation);

    const raw4G = item['4g_bands'] || net['4g_bands'] || item.lte_bands || '';
    const raw5G = item['5g_bands'] || net['5g_bands'] || '';
    const netTech = `${item.network_technology || net.technology || ''} ${raw4G} ${raw5G}`;

    const bands4G = extractBandsList(raw4G);
    const bands5G = extractBandsList(raw5G);
    const has5G = bands5G.length > 0 || /\b5g\b/i.test(netTech);
    const has4G = bands4G.length > 0 || /\b4g\b|\blte\b/i.test(netTech);

    const generations = [];
    if (has4G) generations.push('4G LTE');
    if (has5G) generations.push('5G');

    const brand = String(item.brand_name || item.brand || item.manufacturer || '').trim() || 'Fabricante';
    const rawModel = String(item.name || item.model || query).trim();
    const cleanModel = rawModel.replace(new RegExp(`^${brand}\\s*`, 'i'), '').trim() || rawModel;

    const payload = {
      device: {
        id: `mobileapi-${item.id || cleanModel}`,
        manufacturer: brand,
        model: cleanModel,
        regionalVariant: item.release_date ? `Lançamento: ${item.release_date}` : 'Ficha Técnica Oficial',
        wifi: {
          generation: generation || 'Informação não disponível',
          standards: wifiRaw || 'Informação não disponível',
          bands,
          supports6Ghz: bands.includes('6 GHz'),
          channelWidthsMhz: null,
          mimo: null,
          theoreticalLinkMbps: null,
          favorableRangeMbps: null
        },
        cellular: {
          has4G,
          has5G,
          generations,
          lteCategory: null,
          carrierAggregation: null,
          bands5G,
          bands4G,
          theoreticalDownMbps: null,
          theoreticalUpMbps: null
        },
        source: 'MobileAPI.dev (Consulta Online)',
        dataVersion: new Date().toISOString().slice(0, 10)
      }
    };

    memoryCache.set(cacheKey, { ts: Date.now(), payload });
    return sendJson(res, 200, payload, true);
  } catch (err) {
    console.warn('[TestAi /api/device-specs] Erro interno:', err?.message || err);
    return sendJson(res, 500, { error: 'Erro interno na consulta de especificações' });
  }
}

export default handler;
