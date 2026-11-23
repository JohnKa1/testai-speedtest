import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import './helpers.js';
import { TEST_PROFILES } from '../src/config/speedtest.config.js';
import { createRunAccumulator, SpeedTestService } from '../src/services/speedtest.service.js';
import {
  analyzeLoadedLatencySpikes,
  DIAGNOSIS_CATALOG,
  evaluateConnection
} from '../src/diagnostics/connection-diagnostics.js';
import { evaluateSimpleStability } from '../src/diagnostics/capability-advisor.js';
import { buildShareSummaryText } from '../src/services/share-card.js';
import { buildTechnicalReportTxt } from '../src/storage/history.storage.js';
import { evaluateGamingReadiness } from '../src/diagnostics/gaming-analyzer.js';
import { getCanonicalSpeedMeta, resolvePrimaryAndPeakSpeed } from '../src/utils/formatters.js';
import { METRIC_STATUS } from '../src/utils/validators.js';

function createLatencySamples(valuesMs) {
  return valuesMs.map((ms, idx) => ({ index: idx, ms }));
}

function createFixtureResult({
  measurementMode = 'commercial',
  dlValue = 620.4,
  ulValue = 310.2,
  dlP50 = 540.0,
  ulP50 = 285.0,
  dlPeak = 680.0,
  ulPeak = 345.0,
  pingMs = 11,
  jitterMs = 2.0,
  dlDeltaMs = 4,
  ulDeltaMs = 5,
  dlLatSamples = [14, 15, 16, 15, 14, 15],
  ulLatSamples = [15, 16, 16, 15, 16, 15]
} = {}) {
  const dlPoints = [
    { index: 0, bps: dlP50 * 1e6, mbps: dlP50, elapsedMs: 1000 },
    { index: 1, bps: dlValue * 1e6, mbps: dlValue, elapsedMs: 1500 },
    { index: 2, bps: dlPeak * 1e6, mbps: dlPeak, elapsedMs: 2000 }
  ];
  const ulPoints = [
    { index: 0, bps: ulP50 * 1e6, mbps: ulP50, elapsedMs: 1000 },
    { index: 1, bps: ulValue * 1e6, mbps: ulValue, elapsedMs: 1500 },
    { index: 2, bps: ulPeak * 1e6, mbps: ulPeak, elapsedMs: 2000 }
  ];

  const dlLatPoints = createLatencySamples(dlLatSamples);
  const ulLatPoints = createLatencySamples(ulLatSamples);

  const base = {
    id: 'run-credibility-1',
    timestamp: '2026-11-23T19:45:00.000Z',
    incomplete: false,
    durationMs: 11200,
    measurementMode,
    parallelStreams: { download: 6, upload: 4 },
    profile: { id: 'standard', label: 'Padrão Adaptativo (100 Mbps – 1 Gbps)' },
    context: { linkType: 'ethernet', contractedMbps: null, notes: '' },
    metrics: {
      download: { value: dlValue, status: METRIC_STATUS.MEASURED, unit: 'Mbps' },
      upload: { value: ulValue, status: METRIC_STATUS.MEASURED, unit: 'Mbps' },
      ping: { value: pingMs, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      jitter: { value: jitterMs, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadLatency: { value: pingMs + dlDeltaMs, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadLatency: { value: pingMs + ulDeltaMs, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadJitter: { value: 2.1, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadJitter: { value: 2.4, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadLatencyDelta: { value: dlDeltaMs, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadLatencyDelta: { value: ulDeltaMs, status: METRIC_STATUS.MEASURED, unit: 'ms' }
    },
    stats: {
      download: { count: 8, min: dlP50 * 0.9, p10: dlP50 * 0.92, p50: dlP50, mean: (dlP50 + dlValue) / 2, p90: dlValue, p95: dlPeak, max: dlPeak, stdDev: 20, cv: 0.04 },
      upload: { count: 8, min: ulP50 * 0.9, p10: ulP50 * 0.92, p50: ulP50, mean: (ulP50 + ulValue) / 2, p90: ulValue, p95: ulPeak, max: ulPeak, stdDev: 12, cv: 0.04 },
      unloadedLatency: { count: 10, min: pingMs - 1, p10: pingMs - 1, p50: pingMs, mean: pingMs, p90: pingMs + 2, p95: pingMs + 2, max: pingMs + 3, stdDev: 1, cv: 0.09 },
      downloadLatency: null,
      uploadLatency: null
    },
    transfer: { totalDownloadBytes: 250_000_000, totalUploadBytes: 120_000_000, totalBytes: 370_000_000 },
    series: {
      downloadPoints: dlPoints,
      uploadPoints: ulPoints,
      unloadedLatencyPoints: createLatencySamples(Array(10).fill(pingMs)),
      downloadLatencyPoints: dlLatPoints,
      uploadLatencyPoints: ulLatPoints
    },
    rawSummary: null
  };

  return {
    ...base,
    loadedSpikes: analyzeLoadedLatencySpikes(base)
  };
}

describe('TestAi — Credibilidade das Métricas, Estatística Canônica e Picos sob Carga', () => {
  it('alinha fórmula canônica e rótulos (Download/Upload P90 no commercial e P50 no sustained)', () => {
    const pts = [
      { bps: 80e6, mbps: 80, elapsedMs: 250 },
      { bps: 150e6, mbps: 150, elapsedMs: 500 },
      { bps: 220e6, mbps: 220, elapsedMs: 750 },
      { bps: 400e6, mbps: 400, elapsedMs: 1000 },
      { bps: 420e6, mbps: 420, elapsedMs: 1250 },
      { bps: 460e6, mbps: 460, elapsedMs: 1500 },
      { bps: 500e6, mbps: 500, elapsedMs: 1750 },
      { bps: 560e6, mbps: 560, elapsedMs: 2000 }
    ];

    const commAcc = createRunAccumulator({ measurementMode: 'commercial', rampDiscardMs: 1000 });
    commAcc.state.downloadPoints.push(...pts);
    commAcc.state.uploadPoints.push(...pts);

    const sustAcc = createRunAccumulator({ measurementMode: 'sustained', rampDiscardMs: 1000 });
    sustAcc.state.downloadPoints.push(...pts);
    sustAcc.state.uploadPoints.push(...pts);

    // Commercial usa P90 pós-warmup (536 Mbps) para Download e Upload
    assert.equal(Math.round(commAcc.getDownloadBandwidth() / 1e6), 536);
    assert.equal(Math.round(commAcc.getUploadBandwidth() / 1e6), 536);

    // Sustained usa P50 pós-warmup (460 Mbps, mediana de [400, 420, 460, 500, 560]) para ambos
    assert.equal(Math.round(sustAcc.getDownloadBandwidth() / 1e6), 460);
    assert.equal(Math.round(sustAcc.getUploadBandwidth() / 1e6), 460);

    // Verifica alinhamento entre resultado, diagnóstico, resolvePrimaryAndPeakSpeed, card/resumo e laudo TXT
    const commResult = createFixtureResult({ measurementMode: 'commercial', dlValue: 536.0, ulValue: 536.0, dlP50: 460.0, ulP50: 460.0 });
    const commMeta = getCanonicalSpeedMeta('commercial');
    assert.equal(commMeta.shortLabel, 'P90');
    assert.equal(commMeta.downloadTitle, 'DOWNLOAD (P90)');
    assert.equal(commMeta.uploadTitle, 'Upload (P90)');

    const commDiag = evaluateConnection(commResult);
    assert.ok(commDiag.basisMetrics.some((line) => line.includes('Download (P90): 536.0 Mbps') && line.includes('Upload (P90): 536.0 Mbps')));
    assert.equal(commDiag.observed.includes('Vazão sustentada'), false);

    const commSummary = buildShareSummaryText(commResult, { measurementMode: 'commercial' });
    assert.match(commSummary, /536\.0 Mbps/);
    assert.match(commSummary, /Modo: Comercial \(P90\)/);

    const resolvedComm = resolvePrimaryAndPeakSpeed(
      commResult.series.downloadPoints,
      commResult.metrics.download,
      commResult.stats.download,
      { measurementMode: 'commercial' }
    );
    assert.equal(resolvedComm.primary, 536.0);

    const sustResult = createFixtureResult({ measurementMode: 'sustained', dlValue: 460.0, ulValue: 460.0, dlP50: 460.0, ulP50: 460.0 });
    const sustMeta = getCanonicalSpeedMeta('sustained');
    assert.equal(sustMeta.shortLabel, 'P50');
    assert.equal(sustMeta.downloadTitle, 'DOWNLOAD (P50)');
    assert.equal(sustMeta.uploadTitle, 'Upload (P50)');

    const sustDiag = evaluateConnection(sustResult);
    assert.ok(sustDiag.basisMetrics.some((line) => line.includes('Download (P50): 460.0 Mbps') && line.includes('Upload (P50): 460.0 Mbps')));

    const sustTxt = buildTechnicalReportTxt(sustResult, sustDiag, evaluateGamingReadiness(sustResult));
    assert.ok(sustTxt.includes('Download (P50)'));
    assert.ok(sustTxt.includes('Upload (P50)'));
  });

  it('cenário 1: mediana baixa e sem picos mantém selo ótimo sem nota de pico', () => {
    const cleanResult = createFixtureResult({
      pingMs: 11,
      dlDeltaMs: 3,
      ulDeltaMs: 4,
      dlLatSamples: [13, 14, 15, 14, 14, 13],
      ulLatSamples: [14, 15, 16, 15, 14, 15]
    });

    assert.equal(cleanResult.loadedSpikes.status, 'none');
    assert.equal(cleanResult.loadedSpikes.spikeCount, 0);

    const diag = evaluateConnection(cleanResult);
    assert.equal(diag.code, DIAGNOSIS_CATALOG.EXCELLENT);
    assert.equal(diag.severity, 'good');
    assert.match(diag.summary, /mínima variação sob saturação/);
    assert.equal(diag.summary.includes('pico isolado'), false);

    const stability = evaluateSimpleStability(cleanResult);
    assert.equal(stability.label, 'Excelente');
    assert.equal(stability.tone, 'good');
  });

  it('cenário 2: mediana baixa (Δ +0 ms) com 1 pico isolado (270 ms no upload) mantém selo principal e cita pico + fase', () => {
    const isolatedResult = createFixtureResult({
      pingMs: 11,
      dlDeltaMs: 0,
      ulDeltaMs: 0,
      dlLatSamples: [11, 11, 12, 11, 10, 11, 11, 11],
      ulLatSamples: [11, 10, 11, 270, 11, 11, 12, 11]
    });

    assert.equal(isolatedResult.loadedSpikes.status, 'isolated');
    assert.equal(isolatedResult.loadedSpikes.spikeCount, 1);
    assert.equal(isolatedResult.loadedSpikes.peakMs, 270);
    assert.equal(isolatedResult.loadedSpikes.peakPhase, 'upload');

    const diag = evaluateConnection(isolatedResult);
    assert.equal(diag.code, DIAGNOSIS_CATALOG.EXCELLENT);
    assert.equal(diag.severity, 'good');
    assert.match(diag.summary, /pico isolado de 270 ms durante o upload/);
    assert.equal(diag.summary.includes('mínima variação sob saturação'), false);

    const stability = evaluateSimpleStability(isolatedResult);
    assert.equal(stability.label, 'Excelente');
    assert.equal(stability.tone, 'good');
    assert.match(stability.sub, /270 ms/);
    assert.match(stability.sub, /upload/);
  });

  it('cenário 3: mediana baixa com picos recorrentes (>= 3 amostras ou >= 25%) rebaixa classificação e remove "mínima variação"', () => {
    const recurrentResult = createFixtureResult({
      pingMs: 11,
      dlDeltaMs: 4,
      ulDeltaMs: 5,
      dlLatSamples: [14, 15, 16, 15, 15, 14],
      ulLatSamples: [15, 130, 16, 210, 15, 165, 15, 16]
    });

    assert.equal(recurrentResult.loadedSpikes.status, 'recurrent');
    assert.equal(recurrentResult.loadedSpikes.spikeCount, 3);
    assert.equal(recurrentResult.loadedSpikes.peakMs, 210);
    assert.equal(recurrentResult.loadedSpikes.peakPhase, 'upload');

    const diag = evaluateConnection(recurrentResult);
    assert.equal(diag.severity, 'warning');
    assert.equal(diag.code, DIAGNOSIS_CATALOG.POSSIBLE_CONGESTION);
    assert.equal(diag.summary.includes('mínima variação'), false);
    assert.match(diag.summary, /picos|oscilação/i);
    assert.match(diag.summary, /210 ms/);

    const stability = evaluateSimpleStability(recurrentResult);
    assert.equal(stability.label, 'Moderada');
    assert.equal(stability.tone, 'warning');
  });

  it('SpeedTestService anexa loadedSpikes no resultado consolidado mantendo o padrão do motor', () => {
    const svc = new SpeedTestService();
    svc.startedAt = performance.now() - 1000;
    const mockResults = {
      getDownloadBandwidthPoints: () => [
        { bps: 500e6, mbps: 500, elapsedMs: 1200 },
        { bps: 520e6, mbps: 520, elapsedMs: 1500 }
      ],
      getUploadBandwidthPoints: () => [
        { bps: 250e6, mbps: 250, elapsedMs: 1200 },
        { bps: 260e6, mbps: 260, elapsedMs: 1500 }
      ],
      getUnloadedLatencyPoints: () => [10, 11, 10, 12, 11],
      getDownLoadedLatencyPoints: () => [12, 14, 13],
      getUpLoadedLatencyPoints: () => [13, 240, 14, 13, 15],
      getDownloadBandwidth: () => 518e6,
      getUploadBandwidth: () => 259e6,
      getUnloadedLatency: () => 11,
      getUnloadedJitter: () => 0.8,
      getDownLoadedLatency: () => 13,
      getUpLoadedLatency: () => 14,
      getDownLoadedJitter: () => 1.5,
      getUpLoadedJitter: () => 113.5,
      getSummary: () => ({ measurementMode: 'commercial' })
    };

    const consolidated = svc._buildConsolidatedResult(
      mockResults,
      TEST_PROFILES.standard,
      {},
      false
    );

    assert.ok(consolidated.loadedSpikes);
    assert.equal(consolidated.loadedSpikes.status, 'isolated');
    assert.equal(consolidated.loadedSpikes.peakMs, 240);
    assert.equal(consolidated.loadedSpikes.peakPhase, 'upload');
  });
});
