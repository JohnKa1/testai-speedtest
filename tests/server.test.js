/**
 * Testes de integração HTTP do micro-servidor Node.js em RAM (`server/index.js`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createMeasurementServer, resolveClientIp } from '../server/index.js';

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
    await fn(baseUrl, addr.port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

describe('TestAi — Micro-servidor Node.js em RAM e Blindagem On-Net', () => {
  it('GET e HEAD /api/ping retornam 204 com Server-Timing, Timing-Allow-Origin: *, Cache-Control: no-store e X-TestAi-Route: on-net', async () => {
    await withServer({ allowedOrigin: 'https://speed.isp.test' }, async (baseUrl) => {
      const resGet = await fetch(`${baseUrl}/api/ping`);
      assert.equal(resGet.status, 204);
      const ccGet = resGet.headers.get('cache-control') || '';
      assert.ok(ccGet.includes('no-store') && ccGet.includes('no-cache'));
      assert.equal(resGet.headers.get('timing-allow-origin'), '*');
      assert.equal(resGet.headers.get('x-testai-route'), 'on-net');
      assert.match(resGet.headers.get('server-timing') || '', /^app;dur=\d+\.\d+$/);
      assert.equal(resGet.headers.get('access-control-allow-origin'), 'https://speed.isp.test');

      const resHead = await fetch(`${baseUrl}/api/ping`, { method: 'HEAD' });
      assert.equal(resHead.status, 204);
      assert.equal(resHead.headers.get('timing-allow-origin'), '*');
      assert.equal(resHead.headers.get('x-testai-route'), 'on-net');
      assert.match(resHead.headers.get('server-timing') || '', /^app;dur=\d+\.\d+$/);
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

  it('resolveClientIp e /api/meta respeitam TRUST_PROXY ligado e desligado contra spoofing de IP', async () => {
    // 1. Unitário direto: TRUST_PROXY=false ignora cabeçalhos mesmo vindo de loopback
    assert.equal(
      resolveClientIp(
        {
          headers: { 'x-real-ip': '203.0.113.10', 'x-forwarded-for': '203.0.113.11' },
          socket: { remoteAddress: '127.0.0.1' }
        },
        { trustProxy: false }
      ),
      '127.0.0.1'
    );

    // 2. Unitário direto: TRUST_PROXY=true aceita cabeçalhos vindos de proxy privado/loopback
    assert.equal(
      resolveClientIp(
        {
          headers: { 'x-forwarded-for': '203.0.113.42, 10.0.0.1' },
          socket: { remoteAddress: '::ffff:172.18.0.5' }
        },
        { trustProxy: true }
      ),
      '203.0.113.42'
    );

    // 3. Unitário direto: TRUST_PROXY=true continua rejeitando cabeçalhos se o socket par for IP público direto
    assert.equal(
      resolveClientIp(
        {
          headers: { 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '8.8.8.8' },
          socket: { remoteAddress: '198.51.100.77' }
        },
        { trustProxy: true }
      ),
      '198.51.100.77'
    );

    // 4. Integração HTTP com TRUST_PROXY desligado (padrão): bloqueia falsificação em /api/meta
    await withServer(
      { ispName: 'FibraNorte ISP', serverLabel: 'BNG Manaus 02', trustProxy: false },
      async (baseUrl) => {
        const resUntrusted = await fetch(`${baseUrl}/api/meta`, {
          headers: {
            'X-Real-IP': '198.51.100.77',
            'X-Forwarded-For': '203.0.113.42'
          }
        });
        assert.equal(resUntrusted.status, 200);
        const bodyUntrusted = await resUntrusted.json();
        assert.deepEqual(bodyUntrusted, {
          ispName: 'FibraNorte ISP',
          serverLabel: 'BNG Manaus 02',
          clientIp: '127.0.0.1'
        });
      }
    );

    // 5. Integração HTTP com TRUST_PROXY ligado atrás de proxy local: aceita X-Forwarded-For / X-Real-IP
    await withServer(
      { ispName: 'FibraNorte ISP', serverLabel: 'BNG Manaus 02', trustProxy: true },
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

  it('aplica limites de concorrência por IP (429) e global (503) em /api/down e /api/up e libera slot imediatamente ao abortar conexão', async () => {
    // Segura 2 uploads abertos via http.request streaming para testar bloqueio e liberação imediata no abort
    await withServer(
      { trustProxy: true, maxStreamsPerIp: 2, maxGlobalStreams: 3 },
      async (baseUrl, port) => {
        const openSlowUpload = (clientIp) =>
          new Promise((resolve, reject) => {
            const req = http.request(
              {
                host: '127.0.0.1',
                port,
                path: '/api/up',
                method: 'POST',
                headers: {
                  'X-Real-IP': clientIp,
                  'Transfer-Encoding': 'chunked'
                }
              },
              (res) => {
                resolve({ req, res });
              }
            );
            req.once('error', reject);
            req.write(Buffer.alloc(1024, 0x41));
            // Assim que os bytes chegam no servidor, o slot já foi alocado
            setTimeout(() => resolve({ req, res: null }), 25);
          });

        const u1 = await openSlowUpload('203.0.113.10');
        const u2 = await openSlowUpload('203.0.113.10');

        // 3º stream do mesmo IP -> 429 com Retry-After
        const res429 = await fetch(`${baseUrl}/api/down?bytes=65536`, {
          headers: { 'X-Real-IP': '203.0.113.10' }
        });
        assert.equal(res429.status, 429);
        assert.ok(Number(res429.headers.get('retry-after')) >= 1);
        const body429 = await res429.json();
        assert.equal(body429.code, 'TOO_MANY_STREAMS_PER_IP');

        // /api/ping nunca é bloqueado pelos slots de transferência
        const pingWhileFull = await fetch(`${baseUrl}/api/ping`, {
          headers: { 'X-Real-IP': '203.0.113.10' }
        });
        assert.equal(pingWhileFull.status, 204);

        // 3º stream global vindo de outro IP -> ocupa a 3ª vaga global (maxGlobalStreams = 3)
        const u3 = await openSlowUpload('203.0.113.20');

        // 4º stream global (terceiro IP) -> 503 Service Unavailable com Retry-After
        const res503 = await fetch(`${baseUrl}/api/down?bytes=65536`, {
          headers: { 'X-Real-IP': '203.0.113.30' }
        });
        assert.equal(res503.status, 503);
        assert.ok(Number(res503.headers.get('retry-after')) >= 1);
        const body503 = await res503.json();
        assert.equal(body503.code, 'SERVER_BUSY');

        // Aborta abruptamente u1 e u3 (simulando fechamento de aba pelo cliente)
        u1.req.destroy();
        u3.req.destroy();
        await new Promise((r) => setTimeout(r, 35));

        // Slots devem ter sido liberados sem vazamento: novo download do IP 203.0.113.10 passa com 200
        const resRecovered = await fetch(`${baseUrl}/api/down?bytes=32768`, {
          headers: { 'X-Real-IP': '203.0.113.10' }
        });
        assert.equal(resRecovered.status, 200);
        const bufRecovered = await resRecovered.arrayBuffer();
        assert.equal(bufRecovered.byteLength, 32768);

        // Finaliza u2 normalmente
        await new Promise((resolve) => {
          u2.req.on('response', (res) => {
            res.resume();
            res.on('end', resolve);
          });
          u2.req.end();
        });
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
