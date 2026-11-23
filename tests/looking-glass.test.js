/**
 * Testes unitários e de integração HTTP para o Looking Glass seguro (`server/looking-glass.js`
 * e endpoints `/api/looking-glass` em `server/index.js`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  createRateLimiter,
  isPrivateOrReservedIp,
  LOOKING_GLASS_PRESETS,
  LookingGlassError,
  probeTcpLatency,
  resolveSafeTarget,
  validateLookingGlassTarget
} from '../server/looking-glass.js';
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

describe('TestAi — Looking Glass Seguro: Anti-SSRF, Rate Limit e Sonda TCP (Etapa 1)', () => {
  it('bloqueia IPs privados, loopback, link-local, CGNAT, ULA e IPv4-mapped IPv6 e libera IPs públicos', () => {
    const blockedIps = [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '172.16.0.5',
      '100.64.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '::1',
      'fc00::1',
      'fd12:3456:789a::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1'
    ];

    for (const ip of blockedIps) {
      assert.equal(
        isPrivateOrReservedIp(ip),
        true,
        `Deveria bloquear IP privado/reservado: ${ip}`
      );
    }

    const allowedIps = ['1.1.1.1', '8.8.8.8', '9.9.9.9', '2606:4700:4700::1111'];
    for (const ip of allowedIps) {
      assert.equal(isPrivateOrReservedIp(ip), false, `Deveria permitir IP público: ${ip}`);
    }
  });

  it('valida porta permitida (80/443), presets e rejeita hostnames inválidos ou DNS rebinding', async () => {
    assert.deepEqual(validateLookingGlassTarget({ presetId: 'cloudflare' }), {
      target: '1.1.1.1',
      host: '1.1.1.1',
      port: 443,
      presetId: 'cloudflare'
    });

    assert.deepEqual(validateLookingGlassTarget({ host: '1.1.1.1' }), {
      target: '1.1.1.1',
      host: '1.1.1.1',
      port: 443,
      presetId: null
    });

    assert.deepEqual(validateLookingGlassTarget({ host: 'ec2.sa-east-1.amazonaws.com', port: 80 }), {
      target: 'ec2.sa-east-1.amazonaws.com',
      host: 'ec2.sa-east-1.amazonaws.com',
      port: 80,
      presetId: null
    });

    assert.throws(
      () => validateLookingGlassTarget({ host: '1.1.1.1', port: 22 }),
      (err) => err instanceof LookingGlassError && err.statusCode === 400
    );
    assert.throws(
      () => validateLookingGlassTarget({ host: 'localhost', port: 443 }),
      (err) => err instanceof LookingGlassError && err.statusCode === 400
    );
    assert.throws(
      () => validateLookingGlassTarget({ host: 'http://1.1.1.1/test', port: 443 }),
      (err) => err instanceof LookingGlassError && err.statusCode === 400
    );
    assert.throws(
      () => validateLookingGlassTarget({ presetId: 'inexistente' }),
      (err) => err instanceof LookingGlassError && err.statusCode === 400
    );

    // DNS resolve para IP privado -> 403 SSRF_BLOCKED
    await assert.rejects(
      () =>
        resolveSafeTarget(
          { host: 'rebind.evil.example', port: 443 },
          {
            lookupImpl: async () => [
              { address: '1.1.1.1', family: 4 },
              { address: '169.254.169.254', family: 4 }
            ]
          }
        ),
      (err) => err instanceof LookingGlassError && err.statusCode === 403
    );

    // DNS resolve apenas para IP público -> conecta diretamente no IP validado
    const resolved = await resolveSafeTarget(
      { presetId: 'aws-sp' },
      {
        lookupImpl: async () => [{ address: '54.233.100.10', family: 4 }]
      }
    );
    assert.deepEqual(resolved, {
      target: 'ec2.sa-east-1.amazonaws.com',
      resolvedIp: '54.233.100.10',
      family: 4,
      port: 443,
      presetId: 'aws-sp'
    });
  });

  it('rate limiter controla janela por IP e remove entradas expiradas da RAM', () => {
    let nowMs = 100_000;
    const limiter = createRateLimiter({
      maxRequests: 3,
      windowMs: 60_000,
      nowFn: () => nowMs
    });

    assert.equal(limiter.check('203.0.113.10').allowed, true);
    assert.equal(limiter.check('203.0.113.10').allowed, true);
    assert.equal(limiter.check('203.0.113.10').allowed, true);

    const blocked = limiter.check('203.0.113.10');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.ok(blocked.retryAfterSec >= 1);

    // Outro IP continua independente
    assert.equal(limiter.check('203.0.113.11').allowed, true);
    assert.equal(limiter.size(), 2);

    // Avança além da janela -> poda entradas antigas e libera novamente
    nowMs += 61_000;
    assert.equal(limiter.check('198.51.100.2').allowed, true);
    assert.equal(limiter.size(), 1);
  });

  it('probeTcpLatency mede RTT, min, avg, max, jitter e packetLossPct em servidor TCP local', async () => {
    const tcpServer = net.createServer((socket) => {
      socket.end();
    });

    await new Promise((resolve, reject) => {
      tcpServer.once('error', reject);
      tcpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = tcpServer.address();
    assert.ok(addr && typeof addr === 'object');

    try {
      const result = await probeTcpLatency('127.0.0.1', addr.port, {
        count: 4,
        timeoutMs: 1000,
        target: 'local-test'
      });

      assert.equal(result.target, 'local-test');
      assert.equal(result.resolvedIp, '127.0.0.1');
      assert.equal(result.port, addr.port);
      assert.equal(result.samplesMs.length, 4);
      assert.equal(result.packetLossPct, 0);
      assert.ok(result.minMs !== null && result.minMs >= 0);
      assert.ok(result.avgMs !== null && result.avgMs >= result.minMs);
      assert.ok(result.maxMs !== null && result.maxMs >= result.avgMs);
      assert.ok(result.jitterMs !== null && result.jitterMs >= 0);
    } finally {
      tcpServer.closeAllConnections?.();
      await new Promise((resolve) => tcpServer.close(() => resolve()));
    }

    // Simula perda de 1 em 4 sondas via connectImpl mockado (25% packetLossPct)
    let attempt = 0;
    const partial = await probeTcpLatency('1.1.1.1', 443, {
      count: 4,
      timeoutMs: 300,
      connectImpl: () => {
        attempt += 1;
        const listeners = new Map();
        const sock = {
          once(ev, fn) {
            listeners.set(ev, fn);
          },
          setTimeout() {},
          removeAllListeners() {
            listeners.clear();
          },
          destroy() {}
        };
        queueMicrotask(() => {
          if (attempt === 2) {
            listeners.get('timeout')?.();
          } else {
            listeners.get('connect')?.();
          }
        });
        return sock;
      }
    });

    assert.equal(partial.samplesMs.length, 3);
    assert.equal(partial.packetLossPct, 25);
  });

  it('expõe GET /api/looking-glass/presets e POST /api/looking-glass com Anti-SSRF e HTTP 429', async () => {
    const serverOpts = {
      lookingGlassRateLimit: 2,
      lookingGlassWindowMs: 60_000,
      lookingGlassLookup: async () => [{ address: '1.1.1.1', family: 4 }],
      lookingGlassProbe: async (ip, port, opts) => ({
        target: opts.target,
        resolvedIp: ip,
        port,
        samplesMs: [12.1, 13.4, 11.8, 12.7],
        minMs: 11.8,
        avgMs: 12.5,
        maxMs: 13.4,
        jitterMs: 1.27,
        packetLossPct: 0
      })
    };

    await withServer(serverOpts, async (baseUrl) => {
      // GET /api/looking-glass/presets
      const resPresets = await fetch(`${baseUrl}/api/looking-glass/presets`);
      assert.equal(resPresets.status, 200);
      assert.ok((resPresets.headers.get('cache-control') || '').includes('no-store'));
      const presetsJson = await resPresets.json();
      assert.equal(presetsJson.ok, true);
      assert.deepEqual(presetsJson.presets, LOOKING_GLASS_PRESETS);

      // Bloqueio Anti-SSRF via IP privado (consome 1 tentativa do cliente 10.20.30.1)
      const resSsrf = await fetch(`${baseUrl}/api/looking-glass`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.100.1'
        },
        body: JSON.stringify({ host: '127.0.0.1', port: 443 })
      });
      assert.equal(resSsrf.status, 403);
      assert.ok((resSsrf.headers.get('cache-control') || '').includes('no-store'));

      // Porta inválida -> 400
      const resBadPort = await fetch(`${baseUrl}/api/looking-glass`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.100.2'
        },
        body: JSON.stringify({ host: '1.1.1.1', port: 22 })
      });
      assert.equal(resBadPort.status, 400);

      // Payload > 2 KB -> 413
      const resTooBig = await fetch(`${baseUrl}/api/looking-glass`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.100.3'
        },
        body: JSON.stringify({ presetId: 'cloudflare', pad: 'x'.repeat(3000) })
      });
      assert.equal(resTooBig.status, 413);

      // Fluxo válido + rate limit 429 na 3ª requisição do mesmo IP
      for (let i = 0; i < 2; i += 1) {
        const okRes = await fetch(`${baseUrl}/api/looking-glass`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': '203.0.113.55'
          },
          body: JSON.stringify({ presetId: 'cloudflare' })
        });
        assert.equal(okRes.status, 200);
        assert.ok((okRes.headers.get('cache-control') || '').includes('no-store'));
        const okJson = await okRes.json();
        assert.equal(okJson.ok, true);
        assert.equal(okJson.resolvedIp, '1.1.1.1');
        assert.equal(okJson.avgMs, 12.5);
      }

      const res429 = await fetch(`${baseUrl}/api/looking-glass`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.55'
        },
        body: JSON.stringify({ presetId: 'cloudflare' })
      });
      assert.equal(res429.status, 429);
      assert.ok(Number(res429.headers.get('retry-after')) >= 1);
      assert.ok((res429.headers.get('cache-control') || '').includes('no-store'));
    });
  });
});
