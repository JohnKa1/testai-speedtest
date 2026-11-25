/**
 * Suíte de validação da Onda 2:
 * 1. Spike Guard: pico isolado severo (508 ms e 270 ms) nunca retorna "Excelente" e cita valor + fase.
 * 2. Viés de sobrevivência encerrado: lossPct >= 10% ou >= 2 timeouts sob carga rebaixa estabilidade.
 * 3. Subtítulo fiel ao gatilho + Jitter robusto (poda de 1 único outlier isolado em N >= 6).
 * 4. Coerência entre os 4 classificadores (bufferbloat unidirecional 52 ms / 6 ms e picos recorrentes).
 * 5. Histórico unificado (migração transparente v1/v2, limpeza sincronizada, schemaVersion: 2) + Laudo TXT On-Net + Card PNG + Selo visual de rota.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import './helpers.js';
import { evaluateSimpleStability } from '../src/diagnostics/capability-advisor.js';
import {
  analyzeLoadedLatencySpikes,
  DIAGNOSIS_CATALOG,
  evaluateConnection
} from '../src/diagnostics/connection-diagnostics.js';
import { evaluateGamingReadiness } from '../src/diagnostics/gaming-analyzer.js';
import { evaluateUsageProfiles } from '../src/services/usage-verdict.js';
import { computeJitterMs } from '../src/services/speedtest.service.js';
import {
  buildHistoryEntry,
  clearHistory as clearSimpleHistory,
  exportHistoryAsCsv,
  exportHistoryAsJson,
  loadHistoryEntries,
  saveHistoryEntry
} from '../src/services/history.service.js';
import {
  appendHistoryRecord,
  buildTechnicalReportTxt,
  clearHistory as clearAdvancedHistory,
  LEGACY_HISTORY_V1_KEY,
  loadHistory,
  toHistoryRecord,
  UNIFIED_HISTORY_KEY
} from '../src/storage/history.storage.js';
import { buildShareSummaryText, renderShareCardBlob } from '../src/services/share-card.js';
import { updateRouteOriginBadge } from '../src/ui/telemetry-view.js';
import { formatCoherentDeltaMs } from '../src/utils/formatters.js';
import { METRIC_STATUS } from '../src/utils/validators.js';

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
    hasKey(k) {
      return map.has(k);
    }
  };
}

function buildScenarioResult({
  routeType = 'on-net',
  measurementMode = 'commercial',
  dlMbps = 580,
  dlP50Mbps = 520,
  ulMbps = 290,
  ulP50Mbps = 260,
  pingMs = 11,
  jitterMs = 1.0,
  dlDeltaMs = 10,
  ulDeltaMs = 8,
  dlSamplesMs = [20, 21, 21, 20, 22, 21, 20, 21],
  ulSamplesMs = [18, 19, 19, 18, 20, 19, 18, 19],
  latencyProbes = undefined
} = {}) {
  const base = {
    id: 'run-onda2-fixture',
    timestamp: '2026-11-24T21:00:00.000Z',
    incomplete: false,
    durationMs: 12_000,
    measurementMode,
    routeType,
    parallelStreams: { download: 6, upload: 4 },
    profile: { id: 'standard', label: 'Padrão Adaptativo (100 Mbps – 1 Gbps)' },
    context: { linkType: 'ethernet', contractedMbps: 600, notes: '' },
    metrics: {
      download: { value: dlMbps, status: METRIC_STATUS.MEASURED, unit: 'Mbps' },
      upload: { value: ulMbps, status: METRIC_STATUS.MEASURED, unit: 'Mbps' },
      ping: { value: pingMs, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      jitter: { value: jitterMs, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadLatency: { value: pingMs + dlDeltaMs, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadLatency: { value: pingMs + ulDeltaMs, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadJitter: { value: 2.0, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadJitter: { value: 2.0, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadLatencyDelta: { value: dlDeltaMs, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadLatencyDelta: { value: ulDeltaMs, status: METRIC_STATUS.MEASURED, unit: 'ms' }
    },
    stats: {
      download: { count: 8, min: dlP50Mbps - 20, p10: dlP50Mbps - 15, p50: dlP50Mbps, mean: dlP50Mbps + 10, p90: dlMbps, p95: dlMbps + 15, max: dlMbps + 25, stdDev: 15, cv: 0.03 },
      upload: { count: 8, min: ulP50Mbps - 15, p10: ulP50Mbps - 10, p50: ulP50Mbps, mean: ulP50Mbps + 8, p90: ulMbps, p95: ulMbps + 10, max: ulMbps + 18, stdDev: 10, cv: 0.04 },
      unloadedLatency: { count: 10, min: pingMs - 1, p10: pingMs - 1, p50: pingMs, mean: pingMs, p90: pingMs + 1, p95: pingMs + 2, max: pingMs + 2, stdDev: 0.8, cv: 0.07 },
      downloadLatency: { count: dlSamplesMs.length, min: Math.min(...dlSamplesMs), p10: Math.min(...dlSamplesMs), p50: pingMs + dlDeltaMs, mean: pingMs + dlDeltaMs, p90: Math.max(...dlSamplesMs), p95: Math.max(...dlSamplesMs), max: Math.max(...dlSamplesMs), stdDev: 2, cv: 0.1 },
      uploadLatency: { count: ulSamplesMs.length, min: Math.min(...ulSamplesMs), p10: Math.min(...ulSamplesMs), p50: pingMs + ulDeltaMs, mean: pingMs + ulDeltaMs, p90: Math.max(...ulSamplesMs), p95: Math.max(...ulSamplesMs), max: Math.max(...ulSamplesMs), stdDev: 2, cv: 0.1 }
    },
    transfer: { totalDownloadBytes: 240_000_000, totalUploadBytes: 110_000_000, totalBytes: 350_000_000 },
    series: {
      downloadPoints: [{ index: 0, bps: dlP50Mbps * 1e6, mbps: dlP50Mbps, elapsedMs: 1200 }, { index: 1, bps: dlMbps * 1e6, mbps: dlMbps, elapsedMs: 2000 }],
      uploadPoints: [{ index: 0, bps: ulP50Mbps * 1e6, mbps: ulP50Mbps, elapsedMs: 1200 }, { index: 1, bps: ulMbps * 1e6, mbps: ulMbps, elapsedMs: 2000 }],
      unloadedLatencyPoints: Array.from({ length: 10 }, (_, index) => ({ index, ms: pingMs })),
      downloadLatencyPoints: dlSamplesMs.map((ms, index) => ({ index, ms })),
      uploadLatencyPoints: ulSamplesMs.map((ms, index) => ({ index, ms }))
    },
    latencyProbes,
    rawSummary: null
  };

  return {
    ...base,
    loadedSpikes: analyzeLoadedLatencySpikes(base)
  };
}

describe('TestAi — Validação Obrigatória da Onda 2 (Spike Guard, 4 Classificadores, Histórico Unificado e Rota)', () => {
  it('1. Spike Guard: pico isolado severo de 508 ms (e 270 ms) com Δ +10 ms e jitter 1 ms nunca retorna "Excelente"', () => {
    const spike508 = buildScenarioResult({
      pingMs: 11,
      jitterMs: 1.0,
      dlDeltaMs: 10,
      ulDeltaMs: 8,
      dlSamplesMs: [20, 21, 508, 21, 20, 21, 22, 21]
    });

    assert.equal(spike508.loadedSpikes.status, 'isolated');
    assert.equal(spike508.loadedSpikes.hasSevereSpike, true);
    assert.equal(spike508.loadedSpikes.peakMs, 508);
    assert.equal(spike508.loadedSpikes.peakPhase, 'download');

    const stab508 = evaluateSimpleStability(spike508);
    assert.notEqual(stab508.label, 'Excelente');
    assert.equal(stab508.label, 'Moderada');
    assert.equal(stab508.tone, 'warning');
    assert.match(stab508.sub, /508 ms/);
    assert.match(stab508.sub, /download/);

    const diag508 = evaluateConnection(spike508);
    assert.notEqual(diag508.code, DIAGNOSIS_CATALOG.EXCELLENT);
    assert.equal(diag508.severity, 'warning');
    assert.match(diag508.summary, /508 ms.*download/);

    const spike270 = buildScenarioResult({
      pingMs: 11,
      jitterMs: 1.0,
      dlDeltaMs: 10,
      ulDeltaMs: 8,
      ulSamplesMs: [19, 18, 270, 19, 19, 18, 20, 19]
    });
    const stab270 = evaluateSimpleStability(spike270);
    assert.notEqual(stab270.label, 'Excelente');
    assert.equal(stab270.label, 'Moderada');
    assert.match(stab270.sub, /270 ms.*upload/);
  });

  it('2. encerra viés de sobrevivência: lossPct >= 10% ou >= 2 timeouts sob carga rebaixa estabilidade mesmo com mediana baixa', () => {
    // 15% de perda no download carregado (ex.: 2 falhas em 12 tentativas) -> Moderada
    const moderateLoss = buildScenarioResult({
      pingMs: 10,
      jitterMs: 1.2,
      dlDeltaMs: 4,
      ulDeltaMs: 5,
      latencyProbes: {
        idle: { attempts: 10, succeeded: 10, timeouts: 0, failures: 0, lossPct: 0, maxMs: 11, p95Ms: 11 },
        download: { attempts: 10, succeeded: 8, timeouts: 2, failures: 2, lossPct: 20, maxMs: 15, p95Ms: 15 },
        upload: { attempts: 10, succeeded: 10, timeouts: 0, failures: 0, lossPct: 0, maxMs: 16, p95Ms: 16 }
      }
    });

    const stabMod = evaluateSimpleStability(moderateLoss);
    assert.equal(stabMod.label, 'Moderada');
    assert.equal(stabMod.tone, 'warning');
    assert.match(stabMod.sub, /Perda de 20% nas sondas \(download\)/);

    const diagMod = evaluateConnection(moderateLoss);
    assert.equal(diagMod.severity, 'warning');
    assert.match(diagMod.summary, /20% das sondas/);

    // 40% de perda no upload carregado (bufferbloat severo descartando pacotes) -> Sensível (danger)
    const severeLoss = buildScenarioResult({
      pingMs: 10,
      jitterMs: 1.0,
      dlDeltaMs: 3,
      ulDeltaMs: 4,
      latencyProbes: {
        idle: { attempts: 10, succeeded: 10, timeouts: 0, failures: 0, lossPct: 0, maxMs: 11, p95Ms: 11 },
        download: { attempts: 10, succeeded: 10, timeouts: 0, failures: 0, lossPct: 0, maxMs: 14, p95Ms: 14 },
        upload: { attempts: 10, succeeded: 6, timeouts: 4, failures: 4, lossPct: 40, maxMs: 15, p95Ms: 15 }
      }
    });

    const stabSev = evaluateSimpleStability(severeLoss);
    assert.equal(stabSev.label, 'Sensível');
    assert.equal(stabSev.tone, 'danger');
    assert.match(stabSev.sub, /Perda de 40% nas sondas \(upload\)/);

    const verdictsSev = evaluateUsageProfiles(severeLoss);
    assert.equal(verdictsSev.find((v) => v.id === 'fps-gaming')?.level, 'atencao');
    assert.equal(verdictsSev.find((v) => v.id === 'video-calls')?.level, 'atencao');
    assert.equal(evaluateGamingReadiness(severeLoss).severity, 'danger');
  });

  it('3. subtítulo cita o gatilho real (jitter / ping alto) e computeJitterMs protege fibra limpa contra 1 único outlier isolado', () => {
    // 3a. Quando jitter > 20 ms dispara "Sensível" com maxDelta = 2 ms, o subtítulo cita jitter e nunca "+2 ms sob carga"
    const jitterTriggered = buildScenarioResult({
      pingMs: 14,
      jitterMs: 22.4,
      dlDeltaMs: 2,
      ulDeltaMs: 1
    });
    const stabJitter = evaluateSimpleStability(jitterTriggered);
    assert.equal(stabJitter.label, 'Sensível');
    assert.equal(stabJitter.tone, 'danger');
    assert.match(stabJitter.sub, /Jitter elevado \(22 ms\)/);
    assert.equal(stabJitter.sub.includes('+2 ms'), false);

    // 3b. Ping ocioso extremo (> 150 ms) nunca recebe "Excelente" sem ressalva
    const highIdlePing = buildScenarioResult({
      pingMs: 210,
      jitterMs: 2.0,
      dlDeltaMs: 6,
      ulDeltaMs: 5
    });
    const stabHighPing = evaluateSimpleStability(highIdlePing);
    assert.equal(stabHighPing.label, 'Moderada');
    assert.match(stabHighPing.sub, /Ping alto em repouso \(210 ms\)/);

    // 3c. Poda robusta em computeJitterMs: 1 único outlier (185 ms) em 10 amostras de fibra (~10 ms) não estoura > 20 ms
    const singleOutlierSeries = [10, 10, 11, 10, 185, 10, 11, 10, 10, 11];
    const cleanJitter = computeJitterMs(singleOutlierSeries);
    assert.ok(cleanJitter !== null && cleanJitter < 2.0, `Esperado jitter < 2 ms, obteve ${cleanJitter}`);

    // Mas oscilação real com múltiplos picos (2+ outliers) continua reportando jitter elevado sem mascarar
    const multiSpikeSeries = [10, 65, 11, 70, 10, 68, 11, 72];
    const realHighJitter = computeJitterMs(multiSpikeSeries);
    assert.ok(realHighJitter !== null && realHighJitter > 40);

    // Arredondamento coerente de 1 ms: 11.6 ms (12) -> 15.4 ms (15) exibe Δ +3 ms (e não +4 ms)
    assert.equal(formatCoherentDeltaMs(11.6, 15.4, 3.8), 'Δ +3 ms');
  });

  it('4. coerência entre os 4 classificadores em bufferbloat unidirecional (52 ms / 6 ms) e em picos recorrentes', () => {
    // 4a. Bufferbloat unidirecional: dlDelta = 52 ms, ulDelta = 6 ms
    const unidirectional = buildScenarioResult({
      pingMs: 12,
      jitterMs: 2.0,
      dlDeltaMs: 52,
      ulDeltaMs: 6,
      dlSamplesMs: [62, 64, 65, 64, 63, 64, 65, 64],
      ulSamplesMs: [17, 18, 18, 19, 18, 17, 18, 18]
    });

    const uniStab = evaluateSimpleStability(unidirectional);
    const uniDiag = evaluateConnection(unidirectional);
    const uniUsage = evaluateUsageProfiles(unidirectional);
    const uniGaming = evaluateGamingReadiness(unidirectional);
    const uniFps = uniUsage.find((u) => u.id === 'fps-gaming');

    assert.equal(uniStab.label, 'Moderada');
    assert.equal(uniStab.tone, 'warning');
    assert.equal(uniDiag.code, DIAGNOSIS_CATALOG.POSSIBLE_CONGESTION);
    assert.equal(uniDiag.severity, 'warning');
    assert.equal(uniFps?.level, 'atencao');
    assert.equal(uniGaming.verdictCode, 'lag-under-load');
    assert.equal(uniGaming.severity, 'warning');

    // 4b. Picos recorrentes sob carga propagados para Jogos FPS, Videochamadas e Gaming
    const recurrent = buildScenarioResult({
      pingMs: 11,
      jitterMs: 1.8,
      dlDeltaMs: 5,
      ulDeltaMs: 6,
      ulSamplesMs: [16, 145, 17, 195, 16, 160, 17, 16]
    });

    assert.equal(recurrent.loadedSpikes.status, 'recurrent');
    const recStab = evaluateSimpleStability(recurrent);
    const recDiag = evaluateConnection(recurrent);
    const recUsage = evaluateUsageProfiles(recurrent);
    const recGaming = evaluateGamingReadiness(recurrent);

    assert.equal(recStab.label, 'Moderada');
    assert.equal(recDiag.severity, 'warning');
    assert.notEqual(recUsage.find((u) => u.id === 'fps-gaming')?.level, 'otimo');
    assert.notEqual(recUsage.find((u) => u.id === 'video-calls')?.level, 'otimo');
    assert.notEqual(recUsage.find((u) => u.id === 'streaming-4k')?.level, 'otimo');
    assert.equal(recGaming.verdictCode, 'lag-under-load');
    assert.equal(recGaming.severity, 'warning');
    assert.equal(recGaming.genres[0].tone, 'warning');
  });

  it('5. histórico unificado (migração v1/v2, limpeza sincronizada, schema v2), laudo On-Net sem Cloudflare hardcoded, Card PNG e selo de rota', async () => {
    // 5a. Migração transparente de registros existentes em testai:history:v1 + testai_history_v2 antigo
    const storage = createMemoryStorage({
      [LEGACY_HISTORY_V1_KEY]: JSON.stringify([
        {
          id: 'legacy-v1-only',
          timestamp: '2026-11-20T10:00:00.000Z',
          ispName: 'FibraSul',
          serverLabel: 'POP-RS',
          measurementMode: 'commercial',
          downloadMbps: 610.5,
          uploadMbps: 305.2,
          pingMs: 8,
          jitterMs: 1.2,
          loadedDeltaMs: 6,
          stabilityLabel: 'Excelente'
        }
      ]),
      [UNIFIED_HISTORY_KEY]: JSON.stringify([
        {
          id: 'legacy-v2-only',
          timestamp: '2026-11-21T12:00:00.000Z',
          incomplete: false,
          durationMs: 11000,
          profileLabel: 'Padrão',
          downloadMbps: 490,
          uploadMbps: 245,
          pingMs: 9,
          jitterMs: 1.5,
          downloadLatencyMs: 14,
          uploadLatencyMs: 15,
          downloadLatencyDeltaMs: 5,
          uploadLatencyDeltaMs: 6,
          diagnosisCode: 'excellent',
          diagnosisTitle: 'Excelente'
        }
      ])
    });

    const migratedAll = loadHistory(storage);
    assert.equal(migratedAll.length, 2);
    assert.equal(storage.hasKey(LEGACY_HISTORY_V1_KEY), false, 'Chave legada v1 deve ser migrada e removida');
    assert.ok(migratedAll.every((r) => r.schemaVersion === 2));
    assert.equal(loadHistoryEntries(storage).length, 2);

    // 5b. Novo registro On-Net persiste sustainedDownloadMbps, sustainedUploadMbps, loadedSpikes, latencyProbes e stability
    const onNetCfg = {
      ispName: 'FibraSul Telecom',
      serverLabel: 'POP Matriz 10G',
      measurementMode: 'commercial',
      endpoints: { down: '/api/down', up: '/api/up', ping: '/api/ping' }
    };
    const spikeResult = buildScenarioResult({
      routeType: 'on-net',
      dlMbps: 680.4,
      dlP50Mbps: 590.2,
      ulMbps: 340.1,
      ulP50Mbps: 305.5,
      ulSamplesMs: [18, 19, 310, 18, 19, 18, 19, 18],
      latencyProbes: {
        idle: { attempts: 10, succeeded: 10, timeouts: 0, failures: 0, lossPct: 0, maxMs: 12, p95Ms: 12 },
        download: { attempts: 8, succeeded: 8, timeouts: 0, failures: 0, lossPct: 0, maxMs: 22, p95Ms: 22 },
        upload: { attempts: 8, succeeded: 8, timeouts: 0, failures: 0, lossPct: 0, maxMs: 310, p95Ms: 310 }
      }
    });
    const diag = evaluateConnection(spikeResult);
    const gaming = evaluateGamingReadiness(spikeResult);
    const rec = toHistoryRecord(spikeResult, diag, gaming, onNetCfg);

    saveHistoryEntry(rec, storage);
    const afterSaveAdv = loadHistory(storage);
    const afterSaveSimple = loadHistoryEntries(storage);
    assert.equal(afterSaveAdv.length, 3);
    assert.equal(afterSaveSimple.length, 3);
    assert.equal(afterSaveAdv[0].schemaVersion, 2);
    assert.equal(afterSaveAdv[0].routeType, 'on-net');
    assert.equal(afterSaveAdv[0].sustainedDownloadMbps, 590.2);
    assert.equal(afterSaveAdv[0].sustainedUploadMbps, 305.5);
    assert.equal(afterSaveAdv[0].loadedSpikes?.peakMs, 310);
    assert.equal(afterSaveAdv[0].latencyProbes?.maxMs, 310);
    assert.equal(afterSaveAdv[0].stability?.label, 'Moderada');

    const csvOut = exportHistoryAsCsv(afterSaveSimple);
    const jsonOut = exportHistoryAsJson(afterSaveSimple);
    assert.ok(csvOut.includes('POP Matriz 10G'));
    assert.ok(csvOut.includes('on-net'));
    assert.ok(jsonOut.includes('"sustainedDownloadMbps": 590.2'));

    // Limpar pelo Modo Simples limpa também o Modo Avançado (e vice-versa)
    clearSimpleHistory(storage);
    assert.equal(loadHistory(storage).length, 0);
    assert.equal(loadHistoryEntries(storage).length, 0);

    appendHistoryRecord(rec, storage);
    assert.equal(loadHistoryEntries(storage).length, 1);
    clearAdvancedHistory(storage);
    assert.equal(loadHistoryEntries(storage).length, 0);

    // 5c. Laudo TXT On-Net sem "Cloudflare Edge" hardcoded + Share Summary & PNG com rota e alerta de pico
    const txtOnNet = buildTechnicalReportTxt(spikeResult, diag, gaming, 'Porta óptica 1', onNetCfg);
    assert.equal(txtOnNet.includes('Cloudflare'), false);
    assert.match(txtOnNet, /POP Matriz 10G.*Servidor Local On-Net/);
    assert.match(txtOnNet, /310 ms no upload/);

    const shareSummary = buildShareSummaryText(spikeResult, onNetCfg);
    assert.match(shareSummary, /Servidor Local \(On-Net\)/);
    assert.match(shareSummary, /Moderada/);
    assert.match(shareSummary, /310 ms/);

    const drawnTexts = [];
    await renderShareCardBlob(spikeResult, onNetCfg, {
      createCanvas: (w, h) => ({
        width: w,
        height: h,
        getContext: () => ({
          fillStyle: '',
          strokeStyle: '',
          lineWidth: 1,
          font: '',
          textAlign: 'left',
          beginPath() {},
          moveTo() {},
          lineTo() {},
          quadraticCurveTo() {},
          closePath() {},
          fill() {},
          stroke() {},
          fillRect() {},
          fillText(t) {
            drawnTexts.push(String(t));
          },
          createRadialGradient: () => ({ addColorStop() {} })
        }),
        toBlob(cb) {
          cb(new Blob([new Uint8Array([1])], { type: 'image/png' }));
        }
      })
    });
    assert.ok(drawnTexts.some((t) => t.includes('Servidor Local (On-Net)')));
    assert.ok(drawnTexts.some((t) => t === 'Moderada'));
    assert.ok(drawnTexts.some((t) => t.includes('310 ms')));

    // 5d. Selo visual de rota (On-Net vs Off-Net) e README para provedores
    const prevDoc = globalThis.document;
    const badgeAttrs = new Map();
    const badgeClasses = new Set();
    const textEl = { textContent: '' };
    const badgeEl = {
      textContent: '',
      setAttribute(k, v) {
        badgeAttrs.set(k, String(v));
      },
      classList: {
        toggle(c, force) {
          if (force) badgeClasses.add(c);
          else badgeClasses.delete(c);
        }
      }
    };
    try {
      globalThis.document = /** @type {any} */ ({
        getElementById(id) {
          if (id === 'routeOriginBadge') return badgeEl;
          if (id === 'routeOriginText') return textEl;
          return null;
        }
      });

      updateRouteOriginBadge({ ispName: 'FibraSul' }, 'on-net');
      assert.equal(textEl.textContent, 'Servidor Local • FibraSul');
      assert.equal(badgeAttrs.get('data-route'), 'on-net');
      assert.equal(badgeClasses.has('tone-good'), true);

      updateRouteOriginBadge({ ispName: 'TestAi' }, 'off-net-fallback');
      assert.equal(textEl.textContent, 'Rota Externa • Cloudflare');
      assert.equal(badgeAttrs.get('data-route'), 'off-net-fallback');
      assert.equal(badgeClasses.has('tone-warning'), true);
    } finally {
      globalThis.document = prevDoc;
    }

    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
    assert.ok(readme.includes('Produção Auto-hospedada'));
    assert.ok(readme.includes('Demo Pública'));
    assert.ok(readme.includes('ALLOWED_FRAME_ANCESTORS'));
    assert.ok(readme.includes('allow="clipboard-write"'));
  });
});
