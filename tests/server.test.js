/**
 * Testes de integração HTTP do micro-servidor Node.js em RAM (`server/index.js`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMeasurementServer } from '../server/index.js';

async function withServer(options, fn) {
  const server = createMeasurementServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    await fn(baseUrl);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

describe('TestAi — Micro-servidor Node.js em RAM (Etapa 3)', () => {
  it('GET e HEAD /api/ping retornam 204 No Content com Cache-Control: no-store e CORS', async () => {
    await withServer({ allowedOrigin: 'https://speed.isp.test' }, async (baseUrl) => {
      const resGet = await fetch(`${baseUrl}/api/ping`);
      assert.equal(resGet.status, 204);
      assert.ok((resGet.headers.get('cache-control') || '').includes('no-store'));
      assert.equal(resGet.headers.get('access-control-allow-origin'), 'https://speed.isp.test');

      const resHead = await fetch(`${baseUrl}/api/ping`, { method: 'HEAD' });
      assert.equal(resHead.status, 204);
      assert.ok((resHead.headers.get('cache-control') || '').includes('no-store'));
    });
  });

  it('GET /api/down?bytes=2097152 retorna exatamente 2 MB com Content-Encoding: identity', async () => {
    await withServer({}, async (baseUrl) => {
      const targetBytes = 2_097_152;
      const res = await fetch(`${baseUrl}/api/down?bytes=${targetBytes}`);

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-encoding'), 'identity');
      assert.equal(res.headers.get('content-type'), 'application/octet-stream');
      assert.equal(res.headers.get('content-length'), String(targetBytes));
      assert.ok((res.headers.get('cache-control') || '').includes('no-store'));

      const buf = await res.arrayBuffer();
      assert.equal(buf.byteLength, targetBytes);
    });
  });

  it('GET /api/down rejeita bytes acima de MAX_DOWNLOAD_BYTES ou inválidos com 400', async () => {
    await withServer({ maxDownloadBytes: 1_048_576 }, async (baseUrl) => {
      const resTooHigh = await fetch(`${baseUrl}/api/down?bytes=1048577`);
      assert.equal(resTooHigh.status, 400);
      const bodyHigh = await resTooHigh.json();
      assert.equal(bodyHigh.ok, false);

      const resNegative = await fetch(`${baseUrl}/api/down?bytes=-5`);
      assert.equal(resNegative.status, 400);

      const resNaN = await fetch(`${baseUrl}/api/down?bytes=abc`);
      assert.equal(resNaN.status, 400);
    });
  });

  it('POST /api/up com 1 MB retorna 200 com receivedBytes: 1048576 e respeita teto 413', async () => {
    await withServer({ maxUploadBytes: 2_000_000 }, async (baseUrl) => {
      const payload = new Uint8Array(1_048_576);
      payload.fill(0x5a);

      const res = await fetch(`${baseUrl}/api/up`, {
        method: 'POST',
        body: payload
      });
      assert.equal(res.status, 200);
      assert.ok((res.headers.get('cache-control') || '').includes('no-store'));
      const json = await res.json();
      assert.deepEqual(json, { ok: true, receivedBytes: 1_048_576 });

      const oversize = new Uint8Array(2_100_000);
      const resOver = await fetch(`${baseUrl}/api/up`, {
        method: 'POST',
        body: oversize
      });
      assert.equal(resOver.status, 413);
      const jsonOver = await resOver.json();
      assert.equal(jsonOver.ok, false);
    });
  });

  it('GET /api/meta retorna ispName, serverLabel e clientIp respeitando X-Forwarded-For', async () => {
    await withServer(
      { ispName: 'FibraNorte ISP', serverLabel: 'BNG Manaus 02' },
      async (baseUrl) => {
        const resFwd = await fetch(`${baseUrl}/api/meta`, {
          headers: { 'X-Forwarded-For': '203.0.113.42, 10.0.0.1' }
        });
        assert.equal(resFwd.status, 200);
        const bodyFwd = await resFwd.json();
        assert.deepEqual(bodyFwd, {
          ispName: 'FibraNorte ISP',
          serverLabel: 'BNG Manaus 02',
          clientIp: '203.0.113.42'
        });

        const resReal = await fetch(`${baseUrl}/api/meta`, {
          headers: {
            'X-Real-IP': '198.51.100.77',
            'X-Forwarded-For': '203.0.113.42'
          }
        });
        assert.equal(resReal.status, 200);
        const bodyReal = await resReal.json();
        assert.equal(bodyReal.clientIp, '198.51.100.77');
      }
    );
  });

  it('OPTIONS preflight retorna 204 com headers CORS e rotas desconhecidas retornam 404 JSON', async () => {
    await withServer({ allowedOrigin: 'https://cliente.isp.br' }, async (baseUrl) => {
      const resOpt = await fetch(`${baseUrl}/api/up`, { method: 'OPTIONS' });
      assert.equal(resOpt.status, 204);
      assert.equal(resOpt.headers.get('access-control-allow-origin'), 'https://cliente.isp.br');
      assert.ok((resOpt.headers.get('access-control-allow-methods') || '').includes('POST'));
      assert.ok((resOpt.headers.get('cache-control') || '').includes('no-store'));

      const res404 = await fetch(`${baseUrl}/api/inexistente`);
      assert.equal(res404.status, 404);
      const body404 = await res404.json();
      assert.equal(body404.ok, false);
    });
  });
});
