import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  fetchLookingGlassPresets,
  resolveLookingGlassApiBase,
  runLookingGlassProbe
} from '../src/services/looking-glass.service.js';

test('resolveLookingGlassApiBase resolve apiBaseUrl, endpoints.meta ou mesma origem', () => {
  assert.equal(resolveLookingGlassApiBase({ apiBaseUrl: 'https://speed.isp.test/' }), 'https://speed.isp.test');
  assert.equal(
    resolveLookingGlassApiBase({ endpoints: { meta: 'https://edge.isp.test/api/meta' } }),
    'https://edge.isp.test'
  );
  assert.equal(resolveLookingGlassApiBase({ endpoints: { meta: '/api/meta' } }), '');
  assert.equal(resolveLookingGlassApiBase({}), '');
});

test('fetchLookingGlassPresets trata backend disponível (200 JSON) e fallback estático (404 / HTML)', async () => {
  const samplePresets = [
    { id: 'cloudflare', label: 'Cloudflare DNS', host: '1.1.1.1', port: 443 },
    { id: 'google', label: 'Google DNS', host: '8.8.8.8', port: 443 }
  ];

  // Backend disponível
  const availableRes = await fetchLookingGlassPresets(
    {},
    {
      fetchImpl: async (url) => {
        assert.equal(url, '/api/looking-glass/presets');
        return /** @type {any} */ ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ ok: true, presets: samplePresets })
        });
      }
    }
  );
  assert.equal(availableRes.available, true);
  assert.deepEqual(availableRes.presets, samplePresets);

  // Deploy estático retornando 404
  const notFoundRes = await fetchLookingGlassPresets(
    {},
    {
      fetchImpl: async () =>
        /** @type {any} */ ({
          ok: false,
          status: 404,
          headers: new Headers({ 'content-type': 'text/plain' }),
          json: async () => ({})
        })
    }
  );
  assert.deepEqual(notFoundRes, { available: false, presets: [] });

  // SPA rewrite retornando 200 text/html (ex.: Vercel sem backend Node.js)
  const htmlFallbackRes = await fetchLookingGlassPresets(
    {},
    {
      fetchImpl: async () =>
        /** @type {any} */ ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          json: async () => {
            throw new SyntaxError('Unexpected token <');
          }
        })
    }
  );
  assert.deepEqual(htmlFallbackRes, { available: false, presets: [] });
});

test('runLookingGlassProbe trata 200 (sucesso), 429 (rate limit), 403 (Anti-SSRF) e 404', async () => {
  // Sucesso 200
  const okOutcome = await runLookingGlassProbe(
    { presetId: 'cloudflare' },
    {},
    {
      fetchImpl: async (url, init) => {
        assert.equal(url, '/api/looking-glass');
        assert.equal(init?.method, 'POST');
        return /** @type {any} */ ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            ok: true,
            target: '1.1.1.1',
            resolvedIp: '1.1.1.1',
            port: 443,
            samplesMs: [10.2, 11.1, 10.5, 10.8],
            minMs: 10.2,
            avgMs: 10.65,
            maxMs: 11.1,
            jitterMs: 0.6,
            packetLossPct: 0
          })
        });
      }
    }
  );
  assert.equal(okOutcome.ok, true);
  assert.equal(okOutcome.result?.resolvedIp, '1.1.1.1');
  assert.equal(okOutcome.result?.avgMs, 10.65);

  // Rate limit 429 com Retry-After
  const rateOutcome = await runLookingGlassProbe(
    { presetId: 'google' },
    {},
    {
      fetchImpl: async () =>
        /** @type {any} */ ({
          ok: false,
          status: 429,
          headers: new Headers({ 'content-type': 'application/json', 'retry-after': '45' }),
          json: async () => ({ ok: false, error: 'Muitas requisições.' })
        })
    }
  );
  assert.equal(rateOutcome.ok, false);
  assert.equal(rateOutcome.status, 429);
  assert.equal(rateOutcome.code, 'RATE_LIMITED');
  assert.equal(rateOutcome.retryAfterSec, 45);

  // Anti-SSRF 403
  const ssrfOutcome = await runLookingGlassProbe(
    { host: '127.0.0.1', port: 443 },
    {},
    {
      fetchImpl: async () =>
        /** @type {any} */ ({
          ok: false,
          status: 403,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            ok: false,
            code: 'SSRF_BLOCKED',
            error: 'IP privado bloqueado.'
          })
        })
    }
  );
  assert.equal(ssrfOutcome.ok, false);
  assert.equal(ssrfOutcome.status, 403);
  assert.equal(ssrfOutcome.code, 'SSRF_BLOCKED');

  // 404 estático -> UNAVAILABLE
  const staticOutcome = await runLookingGlassProbe(
    { presetId: 'cloudflare' },
    {},
    {
      fetchImpl: async () =>
        /** @type {any} */ ({
          ok: false,
          status: 404,
          headers: new Headers({ 'content-type': 'text/plain' }),
          json: async () => ({})
        })
    }
  );
  assert.equal(staticOutcome.ok, false);
  assert.equal(staticOutcome.code, 'UNAVAILABLE');
});

test('index.html expõe aba Rota / Jogos e controles do Looking Glass no Modo Avançado', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  assert.ok(html.includes('id="tab-looking-glass"'));
  assert.ok(html.includes('data-tab="looking-glass"'));
  assert.ok(html.includes('id="panel-looking-glass"'));
  assert.ok(html.includes('id="lgUnavailableNotice"'));
  assert.ok(html.includes('id="lgControlsWrap"'));
  assert.ok(html.includes('id="lgPresetsRow"'));
  assert.ok(html.includes('id="lgCustomForm"'));
  assert.ok(html.includes('id="lgHostInput"'));
  assert.ok(html.includes('id="lgPortSelect"'));
  assert.ok(html.includes('id="lgRunBtn"'));
  assert.ok(html.includes('id="lgResultCard"'));
});
