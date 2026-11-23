/**
 * Testes unitários e de integração HTTP para o expositor Prometheus (`/metrics`)
 * e validação estrutural do overlay Caddy (`Caddyfile` e `docker-compose.caddy.yml`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createMetricsRegistry, isValidMetricsAuth } from '../server/metrics.js';
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

describe('TestAi — Métricas Prometheus (/metrics) e Infra Caddy', () => {
  it('renderiza exposição Prometheus válida com # HELP, # TYPE, gauges e contadores', () => {
    let nowMs = 1_000_000;
    const registry = createMetricsRegistry({
      startedAtMs: nowMs,
      nowFn: () => nowMs,
      memoryUsageFn: () => ({ rss: 42_000_000 })
    });

    nowMs += 15_500;
    registry.incActive('download');
    registry.addTransferBytes('download', 2_097_152);
    registry.addTransferBytes('upload', 1_048_576);
    registry.recordRequest('download', 200);
    registry.recordRequest('upload', 200);
    registry.recordLookingGlassOutcome('ok');
    registry.recordLookingGlassOutcome('blocked');
    registry.decActive('download');

    const output = registry.renderPrometheus();

    assert.match(output, /# HELP testai_uptime_seconds/);
    assert.match(output, /# TYPE testai_uptime_seconds gauge\ntestai_uptime_seconds 15\.500/);
    assert.match(
      output,
      /# TYPE testai_process_resident_memory_bytes gauge\ntestai_process_resident_memory_bytes 42000000/
    );
    assert.match(output, /# TYPE testai_active_requests gauge/);
    assert.match(output, /testai_active_requests\{route="download"\} 0/);
    assert.match(output, /testai_active_requests\{route="upload"\} 0/);
    assert.match(output, /testai_active_requests\{route="looking_glass"\} 0/);
    assert.match(output, /# TYPE testai_requests_total counter/);
    assert.match(output, /testai_requests_total\{route="download",status="200"\} 1/);
    assert.match(output, /# TYPE testai_transfer_bytes_total counter/);
    assert.match(output, /testai_transfer_bytes_total\{direction="download"\} 2097152/);
    assert.match(output, /testai_transfer_bytes_total\{direction="upload"\} 1048576/);
    assert.match(output, /# TYPE testai_looking_glass_probes_total counter/);
    assert.match(output, /testai_looking_glass_probes_total\{outcome="ok"\} 1/);
    assert.match(output, /testai_looking_glass_probes_total\{outcome="blocked"\} 1/);
  });

  it('GET /metrics retorna exposição Prometheus atualizada no acesso padrão', async () => {
    const serverOpts = {
      lookingGlassLookup: async () => [{ address: '1.1.1.1', family: 4 }],
      lookingGlassProbe: async (ip, port, opts) => ({
        target: opts.target,
        resolvedIp: ip,
        port,
        samplesMs: [10],
        minMs: 10,
        avgMs: 10,
        maxMs: 10,
        jitterMs: null,
        packetLossPct: 0
      })
    };

    await withServer(serverOpts, async (baseUrl) => {
      const dlRes = await fetch(`${baseUrl}/api/down?bytes=65536`);
      await dlRes.arrayBuffer();

      const ulRes = await fetch(`${baseUrl}/api/up`, {
        method: 'POST',
        body: new Uint8Array(32_768)
      });
      await ulRes.json();

      await fetch(`${baseUrl}/api/looking-glass`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetId: 'cloudflare' })
      });

      await fetch(`${baseUrl}/api/looking-glass`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: '127.0.0.1', port: 443 })
      });

      const metricsRes = await fetch(`${baseUrl}/metrics`);
      assert.equal(metricsRes.status, 200);
      assert.equal(
        metricsRes.headers.get('content-type'),
        'text/plain; version=0.0.4; charset=utf-8'
      );
      assert.ok((metricsRes.headers.get('cache-control') || '').includes('no-store'));

      const body = await metricsRes.text();
      assert.match(body, /testai_transfer_bytes_total\{direction="download"\} 65536/);
      assert.match(body, /testai_transfer_bytes_total\{direction="upload"\} 32768/);
      assert.match(body, /testai_looking_glass_probes_total\{outcome="ok"\} 1/);
      assert.match(body, /testai_looking_glass_probes_total\{outcome="blocked"\} 1/);
    });
  });

  it('GET /metrics exige Bearer METRICS_TOKEN quando configurado e responde 404 com METRICS_ENABLED=false', async () => {
    assert.equal(
      isValidMetricsAuth({ headers: { authorization: 'Bearer segredo-noc' } }, 'segredo-noc'),
      true
    );
    assert.equal(
      isValidMetricsAuth({ headers: { authorization: 'Bearer errado' } }, 'segredo-noc'),
      false
    );
    assert.equal(isValidMetricsAuth({ headers: {} }, 'segredo-noc'), false);

    // Token configurado: 401 sem/com token inválido e 200 com Bearer válido
    await withServer({ metricsToken: 'noc-token-123' }, async (baseUrl) => {
      const noAuth = await fetch(`${baseUrl}/metrics`);
      assert.equal(noAuth.status, 401);

      const badAuth = await fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: 'Bearer wrong-token' }
      });
      assert.equal(badAuth.status, 401);

      const okAuth = await fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: 'Bearer noc-token-123' }
      });
      assert.equal(okAuth.status, 200);
      const txt = await okAuth.text();
      assert.match(txt, /testai_uptime_seconds/);
    });

    // Desativado: 404
    await withServer({ metricsEnabled: false }, async (baseUrl) => {
      const disabled = await fetch(`${baseUrl}/metrics`);
      assert.equal(disabled.status, 404);
    });
  });

  it('Caddyfile, docker-compose.caddy.yml e .env.example seguem contrato sem buffering/compressão em /api/*', () => {
    const root = process.cwd();
    const caddyfile = fs.readFileSync(path.join(root, 'Caddyfile'), 'utf8');
    const caddyCompose = fs.readFileSync(path.join(root, 'docker-compose.caddy.yml'), 'utf8');
    const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

    assert.match(caddyfile, /\{\$DOMAIN(?::[^}]*)?\}/);
    assert.match(caddyfile, /handle\s+\/metrics/);
    assert.match(caddyfile, /reverse_proxy\s+api:3001/);
    assert.match(caddyfile, /flush_interval\s+-1/);
    assert.match(caddyfile, /reverse_proxy\s+web:80/);

    assert.match(caddyCompose, /caddy:2\.8-alpine/);
    assert.match(caddyCompose, /caddy_data:\/data/);
    assert.match(caddyCompose, /caddy_config:\/config/);

    assert.match(envExample, /DOMAIN=/);
    assert.match(envExample, /METRICS_ENABLED=/);
    assert.match(envExample, /METRICS_TOKEN=/);
  });
});
