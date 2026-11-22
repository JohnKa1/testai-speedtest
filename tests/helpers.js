/**
 * Helpers e mocks compartilhados entre as suítes de teste do TestAi.
 */

import { METRIC_STATUS } from '../src/utils/validators.js';

const memoryStore = new Map();

export function setupWindowStorageMock() {
  if (!globalThis.window || !globalThis.window.localStorage) {
    globalThis.window = {
      ...(globalThis.window || {}),
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
  }
  return globalThis.window.localStorage;
}

setupWindowStorageMock();

export function makeResult(overrides = {}) {
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
      uploadLatencyDelta: { value: 5, status: METRIC_STATUS.MEASURED }
    },
    stats: {
      download: { count: 14, min: 410, p50: 465, p90: 480, max: 510, mean: 460, cv: 0.06 },
      upload: { count: 12, min: 205, p50: 230, p90: 240, max: 260, mean: 228, cv: 0.07 },
      unloadedLatency: { count: 20, min: 6, p50: 7, p90: 9, max: 11, mean: 7.4, cv: 0.14 },
      downloadLatency: { count: 15, min: 8, p50: 11, p90: 15, max: 18, mean: 11.5, cv: 0.2 },
      uploadLatency: { count: 15, min: 9, p50: 12, p90: 16, max: 20, mean: 12.2, cv: 0.21 }
    },
    series: {
      downloadPoints: Array.from({ length: 10 }, (_, i) => ({
        mbps: 450 + i * 3,
        bytes: 10_000_000
      })),
      uploadPoints: Array.from({ length: 10 }, (_, i) => ({
        mbps: 220 + i * 2,
        bytes: 5_000_000
      }))
    },
    ...overrides
  };
}

export function createMockOnlineSources() {
  return async (url) => {
    const parsed = new URL(url, 'http://localhost');

    if (parsed.hostname.includes('jsdelivr.net')) {
      return {
        ok: true,
        json: async () => ({
          'SM-A065M': { brand: 'Samsung', name: 'Galaxy A06' },
          'SM-A065F': { brand: 'Samsung', name: 'Galaxy A06' },
          'XT2239-10': { brand: 'Motorola', name: 'moto e22' },
          P610: { brand: 'Positivo', name: 'Twist 4 Pro' }
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
