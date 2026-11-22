import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeResult } from './helpers.js';
import { TEST_PROFILES } from '../src/config/speedtest.config.js';
import { evaluateConnection } from '../src/diagnostics/connection-diagnostics.js';
import { evaluateGamingReadiness } from '../src/diagnostics/gaming-analyzer.js';
import {
  computeRollingWindowMbps,
  parseServerTiming,
  resolveNetworkRttMs,
  selectSteadyStatePoints,
  SpeedTestService
} from '../src/services/speedtest.service.js';
import {
  appendHistoryRecord,
  buildTechnicalReportTxt,
  clearHistory,
  compareHistoryRecords,
  exportHistoryCsv,
  exportHistoryJson,
  loadHistory,
  toHistoryRecord
} from '../src/storage/history.storage.js';
import {
  computeGaugePercent,
  computeMeanMbps,
  computePeakMbps,
  formatMetricWithUnit,
  resolvePrimaryAndPeakSpeed
} from '../src/utils/formatters.js';
import { METRIC_STATUS } from '../src/utils/validators.js';

describe('TestAi — Motor de Medição, Formatadores e Persistência', () => {
  beforeEach(() => {
    clearHistory();
  });

  it('persiste e exporta histórico em JSON e CSV e omite métricas de pico/P90 do laudo', () => {
    const res = makeResult();
    const diag = evaluateConnection(res);
    const gaming = evaluateGamingReadiness(res);

    const rec = toHistoryRecord(res, diag, gaming);
    assert.equal('peakDownloadMbps' in rec, false);
    assert.equal('peakUploadMbps' in rec, false);

    const txt = buildTechnicalReportTxt(res, diag, gaming);
    assert.ok(txt.includes('Download (Média)'));
    assert.ok(txt.includes('Upload (Média)'));
    assert.ok(txt.includes('P50: 465.0 Mbps'));
    assert.equal(txt.includes('P90'), false);
    assert.equal(txt.includes('Pico:'), false);

    const list = appendHistoryRecord(rec);
    assert.equal(list.length, 1);
    assert.equal(loadHistory().length, 1);

    const json = exportHistoryJson(list);
    const csv = exportHistoryCsv(list);
    assert.ok(json.includes('sess-test-001'));
    assert.ok(csv.includes('480'));

    const diff = compareHistoryRecords(rec, { ...rec, downloadMbps: 400 });
    assert.equal(diff.downloadDiffMbps, 80);
  });

  it('alinha todas as opções de #profileSelect com TEST_PROFILES, usa mediana (0.5) e remove peakDownload/peakUpload', () => {
    const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const selectMatch = html.match(/<select id="profileSelect"[^>]*>([\s\S]*?)<\/select>/i);
    assert.ok(selectMatch, 'Seletor #profileSelect deve existir em index.html');

    const optionValues = [...selectMatch[1].matchAll(/<option\s+[^>]*value="([^"]+)"/gi)].map(
      (m) => m[1]
    );
    assert.ok(optionValues.length >= 3);
    for (const value of optionValues) {
      assert.ok(
        Object.hasOwn(TEST_PROFILES, value),
        `Opção "${value}" em #profileSelect deve corresponder a uma chave válida em TEST_PROFILES`
      );
    }

    for (const [id, profile] of Object.entries(TEST_PROFILES)) {
      assert.equal(
        profile.options.bandwidthPercentile,
        0.5,
        `Perfil "${id}" deve usar bandwidthPercentile = 0.5 (mediana sustentada)`
      );
    }

    const svc = new SpeedTestService();
    svc.startedAt = performance.now() - 1000;
    const mockResults = {
      getDownloadBandwidthPoints: () => [
        { bps: 300e6, bytes: 1e7 },
        { bps: 310e6, bytes: 1e7 }
      ],
      getUploadBandwidthPoints: () => [
        { bps: 150e6, bytes: 5e6 },
        { bps: 160e6, bytes: 5e6 }
      ],
      getUnloadedLatencyPoints: () => [8, 9, 10],
      getDownLoadedLatencyPoints: () => [12, 13],
      getUpLoadedLatencyPoints: () => [14, 15],
      getDownloadBandwidth: () => 305e6,
      getUploadBandwidth: () => 155e6,
      getUnloadedLatency: () => 9,
      getUnloadedJitter: () => 1.1,
      getDownLoadedLatency: () => 12.5,
      getUpLoadedLatency: () => 14.5,
      getDownLoadedJitter: () => 2.0,
      getUpLoadedJitter: () => 2.1,
      getSummary: () => ({})
    };

    const consolidated = svc._buildConsolidatedResult(
      mockResults,
      TEST_PROFILES.standard,
      {},
      false
    );
    assert.equal('peakDownload' in consolidated.metrics, false);
    assert.equal('peakUpload' in consolidated.metrics, false);
    assert.equal(consolidated.metrics.download.value, 305);
    assert.equal(consolidated.metrics.upload.value, 155);
  });

  it('formata métricas com unidade apenas quando válidas e calcula percentual do gauge', () => {
    assert.equal(formatMetricWithUnit(44.14, 'Mbps', 1, METRIC_STATUS.MEASURED), '44.1 Mbps');
    assert.equal(formatMetricWithUnit(null, 'Mbps', 1, METRIC_STATUS.FAILED), 'Falha');
    assert.equal(formatMetricWithUnit(null, 'ms', 0, METRIC_STATUS.UNAVAILABLE), 'N/D');
    assert.equal(formatMetricWithUnit(null, 'Mbps', 1, METRIC_STATUS.PENDING), '—');

    assert.equal(computeGaugePercent(null), 0);
    assert.equal(computeGaugePercent(0), 0);
    const pctLow = computeGaugePercent(40);
    const pctHigh = computeGaugePercent(500);
    assert.ok(pctLow > 0 && pctLow < pctHigh);
    assert.equal(computeGaugePercent(2500), 100);
  });

  it('usa média como principal e pico como secundário sem perder status de falha', () => {
    const pts = [{ mbps: 200 }, { mbps: 300 }, { mbps: 400 }];
    assert.equal(computeMeanMbps(pts), 300);
    assert.equal(computePeakMbps(pts), 400);

    const measured = resolvePrimaryAndPeakSpeed(pts, {
      value: 350,
      status: METRIC_STATUS.MEASURED
    });
    assert.deepEqual(measured, {
      primary: 300,
      peak: 400,
      status: METRIC_STATUS.MEASURED
    });

    const failed = resolvePrimaryAndPeakSpeed([], {
      value: null,
      status: METRIC_STATUS.FAILED
    });
    assert.deepEqual(failed, {
      primary: null,
      peak: null,
      status: METRIC_STATUS.FAILED
    });
  });

  it('isola RTT real de picos cfSpeedWorker usando Server-Timing cfL4', () => {
    const parsed = parseServerTiming(
      'cfSpeedEdge;dur=4, cfSpeedWorker;dur=358, cfL4;desc="?proto=TCP&rtt=4245&min_rtt=3784"'
    );
    assert.equal(parsed.serverMs, 362);
    assert.equal(parsed.tcpRttMs, 4.245);

    const immuneRtt = resolveNetworkRttMs({
      wallMs: 366,
      resourceTtfbMs: null,
      serverTimingHeader:
        'cfSpeedEdge;dur=4, cfSpeedWorker;dur=358, cfL4;desc="?proto=TCP&rtt=4245&min_rtt=3784"',
      isLoaded: false
    });
    assert.equal(immuneRtt, 4.245);

    const loadedHttpRtt = resolveNetworkRttMs({
      wallMs: 28,
      resourceTtfbMs: 25,
      serverTimingHeader: 'cfSpeedEdge;dur=2, cfSpeedWorker;dur=5, cfL4;desc="?rtt=19000"',
      isLoaded: true
    });
    assert.equal(loadedHttpRtt, 18);
  });

  it('calcula janela deslizante (rolling window) e descarta ramp-up inicial quando há regime permanente', () => {
    const sample = computeRollingWindowMbps(
      [
        { t: 0, bytes: 0 },
        { t: 250, bytes: 5_000_000 },
        { t: 500, bytes: 15_000_000 },
        { t: 1250, bytes: 45_000_000 }
      ],
      1250,
      1000
    );
    assert.ok(sample);
    assert.equal(sample.duration, 1000);
    assert.equal(sample.bytes, 40_000_000);
    assert.equal(sample.mbps, 320);

    const mixedPoints = [
      { bps: 100e6, elapsedMs: 250 },
      { bps: 180e6, elapsedMs: 750 },
      { bps: 340e6, elapsedMs: 1000 },
      { bps: 350e6, elapsedMs: 1250 },
      { bps: 355e6, elapsedMs: 1500 },
      { bps: 345e6, elapsedMs: 1750 }
    ];
    const steady = selectSteadyStatePoints(mixedPoints, 1000, 4);
    assert.equal(steady.length, 4);
    assert.ok(steady.every((pt) => pt.elapsedMs >= 1000));

    const shortPoints = mixedPoints.slice(0, 3);
    assert.equal(selectSteadyStatePoints(shortPoints, 1000, 4).length, 3);
  });

  it('recupera stalls individuais e 429 no motor multi-stream sem abortar o teste', async () => {
    const origLightOpts = TEST_PROFILES.light.options;
    TEST_PROFILES.light.options = {
      ...origLightOpts,
      loadedLatencyThrottle: 120,
      idlePingCount: 6,
      maxIdleLatencyMs: 300,
      pingTimeoutMs: 120,
      downloadDurationMs: 380,
      uploadDurationMs: 380,
      sampleIntervalMs: 40,
      rollingWindowMs: 250,
      rampDiscardMs: 80,
      downloadStallTimeoutMs: 110,
      uploadStallTimeoutMs: 110,
      downloadConcurrency: 2,
      uploadConcurrency: 2,
      initialDownloadBytes: 500_000,
      maxDownloadBytes: 1_000_000,
      initialUploadBytes: 200_000,
      maxUploadBytes: 500_000
    };

    try {
      let dlW0Calls = 0;
      let dlW1Calls = 0;
      let ulW0Calls = 0;

      const makeAbortableDelay = (ms, signal) =>
        new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error('Aborted'));
            return;
          }
          const t = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          }, ms);
          const onAbort = () => {
            clearTimeout(t);
            reject(new Error('Aborted'));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
        });

      const hangUntilAbort = (signal) =>
        new Promise((_, reject) => {
          if (signal?.aborted) {
            reject(new Error('Aborted'));
            return;
          }
          signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
        });

      const mockFetch = async (url, init = {}) => {
        if (url.includes('bytes=0')) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({
              'server-timing': 'cfSpeedEdge;dur=2, cfSpeedWorker;dur=3, cfL4;desc="?rtt=6000"'
            }),
            text: async () => ''
          };
        }

        const parsed = new URL(url);
        const w = parsed.searchParams.get('w');

        if (parsed.pathname.includes('/__down')) {
          if (w === '0') {
            dlW0Calls += 1;
            if (dlW0Calls === 1) {
              return hangUntilAbort(init.signal);
            }
          }
          if (w === '1') {
            dlW1Calls += 1;
            if (dlW1Calls === 1) {
              return { ok: false, status: 429, headers: new Headers(), text: async () => '' };
            }
          }
          await makeAbortableDelay(20, init.signal);
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            arrayBuffer: async () => new ArrayBuffer(250_000)
          };
        }

        if (parsed.pathname.includes('/__up')) {
          if (w === '0') {
            ulW0Calls += 1;
            if (ulW0Calls === 1) {
              return hangUntilAbort(init.signal);
            }
          }
          await makeAbortableDelay(20, init.signal);
          return { ok: true, status: 200, headers: new Headers(), text: async () => '' };
        }

        return { ok: false, status: 404, headers: new Headers(), text: async () => '' };
      };

      const progressPhases = new Set();
      let finishedResult = null;
      let receivedError = null;

      await new Promise((resolve) => {
        const svc = new SpeedTestService(
          {
            onProgress: (p) => progressPhases.add(p.phase),
            onFinish: (res) => {
              finishedResult = res;
              resolve();
            },
            onError: (err) => {
              receivedError = err;
              resolve();
            }
          },
          { fetchImpl: mockFetch }
        );
        svc.start('light');
      });

      assert.equal(receivedError, null);
      assert.ok(finishedResult);
      assert.equal(finishedResult.incomplete, false);
      assert.equal(finishedResult.metrics.download.status, METRIC_STATUS.MEASURED);
      assert.equal(finishedResult.metrics.upload.status, METRIC_STATUS.MEASURED);
      assert.equal(finishedResult.metrics.ping.status, METRIC_STATUS.MEASURED);
      assert.ok(finishedResult.metrics.download.value > 0);
      assert.ok(finishedResult.metrics.upload.value > 0);
      assert.ok(
        Math.abs(finishedResult.metrics.download.value - finishedResult.stats.download.mean) < 1e-6
      );
      assert.ok(
        Math.abs(finishedResult.metrics.upload.value - finishedResult.stats.upload.mean) < 1e-6
      );
      assert.ok(finishedResult.rawSummary.downloadStallsRecovered >= 1);
      assert.ok(finishedResult.rawSummary.uploadStallsRecovered >= 1);
      assert.ok(finishedResult.rawSummary.rateLimitDownshifts >= 1);
      assert.ok(progressPhases.has('latency'));
      assert.ok(progressPhases.has('download'));
      assert.ok(progressPhases.has('upload'));
    } finally {
      TEST_PROFILES.light.options = origLightOpts;
    }
  });

  it('cancela medição de forma limpa sem vazar callbacks posteriores', async () => {
    let canceledCount = 0;
    let finishedCount = 0;
    let errorCount = 0;

    const svc = new SpeedTestService(
      {
        onCancel: () => {
          canceledCount += 1;
        },
        onFinish: () => {
          finishedCount += 1;
        },
        onError: () => {
          errorCount += 1;
        }
      },
      {
        fetchImpl: (_url, init) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), {
              once: true
            });
          })
      }
    );

    svc.start('light');
    assert.equal(svc.isRunning(), true);

    await new Promise((r) => setTimeout(r, 30));
    svc.cancel();
    assert.equal(svc.isRunning(), false);
    assert.equal(canceledCount, 1);

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(finishedCount, 0);
    assert.equal(errorCount, 0);
  });
});
