import fs from 'node:fs';
import { expandTolerantDeviceQuery } from '../src/services/device-specs.service.js';
import path from 'node:path';
import {
  deriveDeviceCategory,
  deriveWifiBandAverages
} from '../src/diagnostics/capability-advisor.js';

const CACHE_TTL_MS = 1000 * 60 * 60 * 12;
export const MAX_CACHE_ENTRIES = 500;
export const RATE_LIMIT_MAX_REQUESTS = 20;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_IPS = 2000;
const MOBILE_API_TIMEOUT_MS = 4500;
const memoryCache = new Map();
const ipRateLimitMap = new Map();
let lastRateLimitSweep = 0;
let preferredAuthMethod = null;

export function getDeviceSpecsCacheSize() {
  return memoryCache.size;
}

export function clearDeviceSpecsRateLimit() {
  ipRateLimitMap.clear();
  lastRateLimitSweep = 0;
}

export function clearDeviceSpecsCache() {
  memoryCache.clear();
  clearDeviceSpecsRateLimit();
  preferredAuthMethod = null;
}

function setCacheEntry(cacheKey, payload, now = Date.now()) {
  for (const [key, entry] of memoryCache.entries()) {
    if (now - entry.ts >= CACHE_TTL_MS) {
      memoryCache.delete(key);
    }
  }
  if (memoryCache.has(cacheKey)) {
    memoryCache.delete(cacheKey);
  }
  while (memoryCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey === undefined) break;
    memoryCache.delete(oldestKey);
  }
  memoryCache.set(cacheKey, { ts: now, payload });
}

function getHeader(req, headerName) {
  const headers = req?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return String(headers.get(headerName) || '');
  }
  const target = headerName.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return Array.isArray(v) ? String(v[0] || '') : String(v || '');
    }
  }
  return '';
}

function extractClientIp(req) {
  for (const headerName of ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for']) {
    const raw = getHeader(req, headerName);
    if (!raw) continue;
    for (const part of raw.split(',')) {
      const candidate = part.trim();
      if (candidate && /^[0-9a-fA-F:.]{3,45}$/.test(candidate)) {
        return candidate;
      }
    }
  }
  return (
    String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || 'unknown').trim() ||
    'unknown'
  );
}

function checkRateLimit(ip, now = Date.now()) {
  if (now - lastRateLimitSweep >= 30_000 || ipRateLimitMap.size >= RATE_LIMIT_MAX_IPS) {
    lastRateLimitSweep = now;
    for (const [key, rec] of ipRateLimitMap.entries()) {
      if (now - rec.windowStart >= RATE_LIMIT_WINDOW_MS) {
        ipRateLimitMap.delete(key);
      }
    }
  }

  const existing = ipRateLimitMap.get(ip);
  if (!existing || now - existing.windowStart >= RATE_LIMIT_WINDOW_MS) {
    if (existing) {
      ipRateLimitMap.delete(ip);
    }
    while (ipRateLimitMap.size >= RATE_LIMIT_MAX_IPS) {
      const oldestIp = ipRateLimitMap.keys().next().value;
      if (oldestIp === undefined) break;
      ipRateLimitMap.delete(oldestIp);
    }
    ipRateLimitMap.set(ip, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (existing.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false };
  }

  existing.count += 1;
  return { allowed: true };
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function loadMobileApiKey() {
  if (process.env.MOBILEAPI_KEY) {
    const k = String(process.env.MOBILEAPI_KEY).trim().replace(/^["']|["']$/g, '');
    if (k && k !== 'COLE_SUA_CHAVE_AQUI') return k;
  }

  for (const filename of ['.env.local', '.env']) {
    try {
      const envPath = path.resolve(process.cwd(), filename);
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
  }

  return '';
}

function cleanSpecField(raw) {
  return String(raw ?? '')
    .replace(/&nbsp;|&#0*160;|&#x0*a0;|\u00a0/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeQuery(raw) {
  return cleanSpecField(raw)
    .replace(/[<>"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function sendJson(res, statusCode, payload, cacheable = false) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
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

export function parseWifiGeneration(wifiText) {
  const txt = String(wifiText || '');
  if (/802\.11\s*[a-z0-9/]*(?:be|\/7)\b|wi-?fi\s*7\b/i.test(txt)) return 'Wi-Fi 7';
  if (/802\.11\s*[a-z0-9/]*\/6e\b|wi-?fi\s*6e\b|6\s*ghz/i.test(txt)) return 'Wi-Fi 6E';
  if (/802\.11\s*[a-z0-9/]*(?:ax|\/6)\b|wi-?fi\s*6\b/i.test(txt)) return 'Wi-Fi 6';
  if (/802\.11\s*[a-z0-9/]*ac\b|wi-?fi\s*5\b/i.test(txt)) return 'Wi-Fi 5';
  if (/802\.11\s*[a-z0-9/]*n\b|wi-?fi\s*4\b/i.test(txt)) return 'Wi-Fi 4';
  if (/802\.11\s*[a-z0-9/]*[bg]\b/i.test(txt)) return 'Wi-Fi 3 (802.11b/g)';
  return null;
}

export function parseWifiBands(wifiText, generation) {
  const txt = String(wifiText || '');
  const bands = [];
  const supports6Ghz =
    generation === 'Wi-Fi 6E' ||
    generation === 'Wi-Fi 7' ||
    /tri-?band|6\s*ghz/i.test(txt);

  if (txt) {
    if (/2\.4\s*ghz|dual-?band|tri-?band|802\.11|wi-?fi/i.test(txt)) bands.push('2,4 GHz');
    if (
      /5\s*ghz|dual-?band|tri-?band|802\.11\s*[a-z0-9/]*(?:a|ac|ax|be|\/6e?|\/7)\b/i.test(txt) ||
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

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

export function selectBestMobileApiMatch(list, query) {
  const candidates = Array.isArray(list) ? list.filter((d) => d && (d.name || d.model)) : [];
  if (candidates.length === 0) return null;

  const queryTokens = normalizeTokens(query);
  if (queryTokens.length === 0) return candidates[0];

  const querySet = new Set(queryTokens);
  let bestItem = candidates[0];
  let bestScore = -Infinity;

  for (const item of candidates) {
    const brand = String(item.brand_name || item.brand || item.manufacturer || '').trim();
    const rawName = String(item.name || item.model || '').trim();
    const fullText =
      brand && !rawName.toLowerCase().startsWith(brand.toLowerCase())
        ? `${brand} ${rawName}`.trim()
        : rawName;
    const modelOnly = brand
      ? rawName.replace(new RegExp(`^${escapeRegExp(brand)}\\s*`, 'i'), '').trim() || rawName
      : rawName;

    const fullTokens = normalizeTokens(fullText);
    const modelTokens = normalizeTokens(modelOnly);
    const fullSet = new Set(fullTokens);
    const modelSet = new Set(modelTokens);

    let score = 0;
    let exactMatches = 0;

    for (const qt of queryTokens) {
      if (fullSet.has(qt)) {
        score += 3;
        exactMatches += 1;
      } else if (fullTokens.some((ft) => ft.startsWith(qt) || qt.startsWith(ft))) {
        score += 1;
      }
    }

    if (
      exactMatches === queryTokens.length &&
      (setsEqual(querySet, modelSet) || setsEqual(querySet, fullSet))
    ) {
      score += 5;
    }

    const extraTokens = fullTokens.filter((ft) => !querySet.has(ft)).length;
    score -= extraTokens * 0.25;

    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }

  return bestItem;
}

export async function fetchFromMobileApi(baseUrl, mobileApiKey, options = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = MOBILE_API_TIMEOUT_MS } = options;
  if (typeof fetchImpl !== 'function') return null;

  const usePreferredCache = fetchImpl === globalThis.fetch;
  const cleanBaseUrl = new URL(baseUrl.toString());
  cleanBaseUrl.searchParams.delete('key');

  async function requestOnce(urlStr, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(urlStr, {
        method: 'GET',
        headers,
        signal: controller.signal
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const methods = [
    {
      id: 'bearer',
      run: () =>
        requestOnce(cleanBaseUrl.toString(), {
          Accept: 'application/json',
          Authorization: `Bearer ${mobileApiKey}`
        })
    },
    {
      id: 'token',
      run: () =>
        requestOnce(cleanBaseUrl.toString(), {
          Accept: 'application/json',
          Authorization: `Token ${mobileApiKey}`
        })
    },
    {
      id: 'query',
      run: () => {
        const urlWithKey = new URL(cleanBaseUrl.toString());
        urlWithKey.searchParams.set('key', mobileApiKey);
        return requestOnce(urlWithKey.toString(), {
          Accept: 'application/json'
        });
      }
    },
    {
      id: 'x-api-key',
      run: () =>
        requestOnce(cleanBaseUrl.toString(), {
          Accept: 'application/json',
          'X-API-Key': mobileApiKey
        })
    }
  ];

  const orderedMethods =
    usePreferredCache && preferredAuthMethod
      ? [
          ...methods.filter((m) => m.id === preferredAuthMethod),
          ...methods.filter((m) => m.id !== preferredAuthMethod)
        ]
      : methods;

  let lastResp = null;

  for (const method of orderedMethods) {
    const resp = await method.run();
    if (!resp) {
      return null;
    }
    if (resp.status !== 401 && resp.status !== 403) {
      if (usePreferredCache) {
        preferredAuthMethod = method.id;
      }
      return resp;
    }
    lastResp = resp;
    await resp.body?.cancel?.().catch(() => {});
  }

  return lastResp;
}

export async function handler(req, res, deps = {}) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const allowedOriginRaw = String(
    deps.allowedOrigin !== undefined ? deps.allowedOrigin : process.env.ALLOWED_ORIGIN || ''
  ).trim();

  if (allowedOriginRaw && allowedOriginRaw !== '*') {
    const allowedOrigins = allowedOriginRaw
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean);

    const requestOrigin = getHeader(req, 'origin').trim().replace(/\/+$/, '');
    if (requestOrigin) {
      if (!allowedOrigins.includes(requestOrigin)) {
        return sendJson(res, 403, { error: 'Origem não autorizada' });
      }
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Vary', 'Origin');
    } else {
      const referer = getHeader(req, 'referer').trim();
      if (referer) {
        let refererOrigin = '';
        try {
          refererOrigin = new URL(referer).origin;
        } catch {
          refererOrigin = '';
        }
        if (!refererOrigin || !allowedOrigins.includes(refererOrigin)) {
          return sendJson(res, 403, { error: 'Origem não autorizada' });
        }
      } else if (getHeader(req, 'sec-fetch-site').trim().toLowerCase() !== 'same-origin') {
        return sendJson(res, 403, { error: 'Origem não autorizada' });
      }
    }
  }

  const clientIp = extractClientIp(req);
  const rateCheck = checkRateLimit(clientIp);
  if (!rateCheck.allowed) {
    res.setHeader('Retry-After', '60');
    return sendJson(res, 429, {
      error: 'Limite de consultas excedido. Tente novamente em instantes.'
    });
  }

  const parsedUrl = new URL(req.url || '', 'http://localhost');
  const rawQ = req.query?.q ?? parsedUrl.searchParams.get('q');
  const query = expandTolerantDeviceQuery(sanitizeQuery(rawQ));

  if (!query || query.length < 2) {
    return sendJson(res, 400, { error: 'Consulta inválida' });
  }

  const cacheKey = query.toLowerCase();
  const cached = memoryCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return sendJson(res, 200, cached.payload, true);
  }

  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const mobileApiKey = deps.apiKey !== undefined ? deps.apiKey : loadMobileApiKey();
  if (!mobileApiKey) {
    return sendJson(res, 503, { error: 'MOBILEAPI_KEY não configurada no servidor' });
  }

  try {
    const searchUrl = new URL('https://api.mobileapi.dev/devices/search/');
    searchUrl.searchParams.set('name', query);

    const resp = await fetchFromMobileApi(searchUrl, mobileApiKey, { fetchImpl });
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
    let item = selectBestMobileApiMatch(list, query);

    if (!item) {
      return sendJson(res, 404, { error: 'Dispositivo não encontrado na MobileAPI.dev' });
    }

    const hasCommsInHit = Boolean(
      item.wlan || item.comms || item.communications || item.specifications || item['4g_bands']
    );
    if (!hasCommsInHit && item.id) {
      const detailUrl = new URL(`https://api.mobileapi.dev/devices/${encodeURIComponent(item.id)}/`);
      const detailResp = await fetchFromMobileApi(detailUrl, mobileApiKey, { fetchImpl });
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

    const wifiRaw = cleanSpecField(
      item.wlan || comms.wlan || item.wifi || comms.wifi || item.connectivity || ''
    );
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

    const chipset =
      cleanSpecField(
        item.chipset ||
          item.platform?.chipset ||
          item.specifications?.platform?.chipset ||
          item.soc ||
          item.cpu ||
          ''
      ).slice(0, 80) || null;

    const ram =
      cleanSpecField(
        item.ram ||
          item.memory?.ram ||
          item.memory?.internal ||
          item.specifications?.memory?.internal ||
          ''
      ).slice(0, 80) || null;

    const brand =
      cleanSpecField(item.brand_name || item.brand || item.manufacturer || '') || 'Fabricante';
    const rawModel = cleanSpecField(item.name || item.model || query);
    const cleanModel =
      brand !== 'Fabricante'
        ? rawModel.replace(new RegExp(`^${escapeRegExp(brand)}\\s*`, 'i'), '').trim() || rawModel
        : rawModel;

    const device = {
      id: `mobileapi-${item.id || cleanModel}`,
      manufacturer: brand,
      model: cleanModel,
      regionalVariant: item.release_date
        ? `Lançamento: ${item.release_date}`
        : 'Ficha Técnica Oficial',
      hardware: {
        chipset,
        ram
      },
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
    };

    device.category = deriveDeviceCategory(device);
    device.wifiBandAverages = deriveWifiBandAverages(device);

    const payload = { device };

    setCacheEntry(cacheKey, payload);
    return sendJson(res, 200, payload, true);
  } catch (err) {
    console.warn('[TestAi /api/device-specs] Erro interno:', err?.message || err);
    return sendJson(res, 500, { error: 'Erro interno na consulta de especificações' });
  }
}

export default handler;
