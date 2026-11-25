import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildHistoryEntry,
  clearHistory,
  computeComparisonDelta,
  exportHistoryAsCsv,
  exportHistoryAsJson,
  HISTORY_STORAGE_KEY,
  loadHistoryEntries,
  MAX_HISTORY_ENTRIES,
  saveHistoryEntry
} from '../src/services/history.service.js';
import { evaluateUsageProfiles } from '../src/services/usage-verdict.js';
import { METRIC_STATUS } from '../src/utils/validators.js';

function createMemoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    }
  };
}

function createSampleResult({
  id = 'run-1',
  timestamp = '2026-11-23T15:00:00.000Z',
  downloadMbps = 320,
  uploadMbps = 180,
  pingMs = 12,
  jitterMs = 2.0,
  loadedDeltaMs = 8,
  incomplete = false
} = {}) {
  return {
    id,
    timestamp,
    incomplete,
    measurementMode: 'sustained',
    metrics: {
      download: { value: downloadMbps, status: METRIC_STATUS.MEASURED, unit: 'Mbps' },
      upload: { value: uploadMbps, status: METRIC_STATUS.MEASURED, unit: 'Mbps' },
      ping: { value: pingMs, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      jitter: { value: jitterMs, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadLatency: {
        value: pingMs + loadedDeltaMs,
        status: METRIC_STATUS.MEASURED,
        unit: 'ms'
      },
      uploadLatency: {
        value: pingMs + Math.round(loadedDeltaMs * 0.6),
        status: METRIC_STATUS.MEASURED,
        unit: 'ms'
      },
      downloadJitter: { value: jitterMs + 1, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadJitter: { value: jitterMs + 1, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      downloadLatencyDelta: { value: loadedDeltaMs, status: METRIC_STATUS.MEASURED, unit: 'ms' },
      uploadLatencyDelta: {
        value: Math.round(loadedDeltaMs * 0.6),
        status: METRIC_STATUS.MEASURED,
        unit: 'ms'
      }
    },
    stats: {
      download: { count: 5, min: downloadMbps, p10: downloadMbps, p50: downloadMbps, mean: downloadMbps, p90: downloadMbps, p95: downloadMbps, max: downloadMbps, stdDev: 0, cv: 0 },
      upload: { count: 5, min: uploadMbps, p10: uploadMbps, p50: uploadMbps, mean: uploadMbps, p90: uploadMbps, p95: uploadMbps, max: uploadMbps, stdDev: 0, cv: 0 },
      unloadedLatency: null,
      downloadLatency: null,
      uploadLatency: null
    },
    series: {
      downloadPoints: [{ index: 0, bps: downloadMbps * 1_000_000, mbps: downloadMbps }],
      uploadPoints: [{ index: 0, bps: uploadMbps * 1_000_000, mbps: uploadMbps }],
      unloadedLatencyPoints: [],
      downloadLatencyPoints: [],
      uploadLatencyPoints: []
    }
  };
}

test('history.service grava até 10 testes, recupera JSON corrompido e limpa histórico', () => {
  const storage = createMemoryStorage();

  for (let i = 1; i <= 12; i += 1) {
    const entry = buildHistoryEntry(
      createSampleResult({
        id: `run-${i}`,
        downloadMbps: 100 + i
      }),
      { ispName: 'LinkSul', serverLabel: 'BNG-01', measurementMode: 'sustained' }
    );
    saveHistoryEntry(entry, storage);
  }

  const loaded = loadHistoryEntries(storage);
  assert.equal(loaded.length, MAX_HISTORY_ENTRIES);
  assert.equal(loaded[0].id, 'run-12');
  assert.equal(loaded[9].id, 'run-3');
  assert.equal(loaded[0].ispName, 'LinkSul');
  assert.equal(loaded[0].serverLabel, 'BNG-01');

  // Recuperação segura quando JSON está corrompido
  const corruptedStorage = createMemoryStorage({ [HISTORY_STORAGE_KEY]: '{json-invalido' });
  assert.deepEqual(loadHistoryEntries(corruptedStorage), []);

  // Storage nulo/bloqueado não lança exceção
  assert.deepEqual(loadHistoryEntries(null), []);
  assert.deepEqual(clearHistory(null), []);

  // Limpeza real do storage
  const afterClear = clearHistory(storage);
  assert.deepEqual(afterClear, []);
  assert.deepEqual(loadHistoryEntries(storage), []);
});

test('computeComparisonDelta calcula deltas em relação ao teste anterior ou retorna null', () => {
  const current = buildHistoryEntry(
    createSampleResult({ downloadMbps: 342.5, uploadMbps: 190.2, pingMs: 10, loadedDeltaMs: 6 })
  );
  const previous = buildHistoryEntry(
    createSampleResult({ downloadMbps: 300.0, uploadMbps: 175.0, pingMs: 16, loadedDeltaMs: 14 })
  );

  assert.equal(computeComparisonDelta(current, null), null);

  const delta = computeComparisonDelta(current, previous);
  assert.deepEqual(delta, {
    downloadDeltaMbps: 42.5,
    uploadDeltaMbps: 15.2,
    pingDeltaMs: -6,
    loadedDeltaMs: -8
  });
});

test('exportHistoryAsCsv e exportHistoryAsJson geram CSV escapado e JSON identado', () => {
  const entries = [
    {
      id: 'run-1',
      timestamp: '2026-11-23T15:00:00.000Z',
      ispName: 'ISP "Fibra", Sul',
      serverLabel: 'POP Centro',
      measurementMode: 'commercial',
      downloadMbps: 500.5,
      uploadMbps: 250.25,
      pingMs: 11,
      jitterMs: 1.5,
      loadedDeltaMs: 7,
      stabilityLabel: 'Excelente'
    }
  ];

  const csv = exportHistoryAsCsv(entries);
  const lines = csv.split('\n');
  assert.ok(lines[0].startsWith('schemaVersion,id,timestamp,ispName,serverLabel,routeType,measurementMode,'));
  assert.ok(lines[0].includes('sustainedDownloadMbps'));
  assert.ok(lines[0].includes('spikePeakMs'));
  assert.ok(lines[0].includes('probeLossPct'));
  assert.ok(lines[0].includes('stabilityLabel,stabilityTone,stabilityReason'));
  assert.ok(lines[1].includes('"ISP ""Fibra"", Sul"'));
  assert.ok(lines[1].includes('500.5'));
  assert.ok(lines[1].includes('Excelente'));

  const json = exportHistoryAsJson(entries);
  assert.ok(json.includes('\n  '));
  const parsedJson = JSON.parse(json);
  assert.equal(parsedJson.length, 1);
  assert.equal(parsedJson[0].schemaVersion, 2);
  assert.equal(parsedJson[0].id, 'run-1');
  assert.equal(parsedJson[0].ispName, 'ISP "Fibra", Sul');
  assert.equal(parsedJson[0].stability.label, 'Excelente');
});

test('evaluateUsageProfiles classifica rede excelente, intermediária e bufferbloat severo', () => {
  // Rede excelente
  const excellent = evaluateUsageProfiles(
    createSampleResult({ downloadMbps: 400, uploadMbps: 200, pingMs: 12, jitterMs: 2.0, loadedDeltaMs: 8 })
  );
  assert.equal(excellent.length, 3);
  for (const item of excellent) {
    assert.equal(item.level, 'otimo');
    assert.equal(item.label, 'Ótimo');
  }

  // Rede intermediária
  const mid = evaluateUsageProfiles(
    createSampleResult({ downloadMbps: 45, uploadMbps: 15, pingMs: 36, jitterMs: 8.0, loadedDeltaMs: 28 })
  );
  const midFps = mid.find((v) => v.title === 'Jogos FPS');
  const midCalls = mid.find((v) => v.title === 'Videochamadas');
  const mid4k = mid.find((v) => v.title === 'Streaming 4K');
  assert.equal(midFps?.level, 'bom');
  assert.equal(midCalls?.level, 'bom');
  assert.equal(mid4k?.level, 'bom');

  // Rede com download alto (600 Mbps), porém Δ sob carga alto (95 ms) derrubando Jogos FPS
  const bloated = evaluateUsageProfiles(
    createSampleResult({ downloadMbps: 600, uploadMbps: 120, pingMs: 16, jitterMs: 2.5, loadedDeltaMs: 95 })
  );
  const bloatedFps = bloated.find((v) => v.title === 'Jogos FPS');
  assert.equal(bloatedFps?.level, 'atencao');
  assert.equal(bloatedFps?.label, 'Atenção');
  assert.match(bloatedFps?.reason || '', /95 ms|bufferbloat/i);

  // Rede degradada geral
  const poor = evaluateUsageProfiles(
    createSampleResult({ downloadMbps: 18, uploadMbps: 5, pingMs: 85, jitterMs: 20, loadedDeltaMs: 40 })
  );
  for (const item of poor) {
    assert.equal(item.level, 'atencao');
    assert.equal(item.label, 'Atenção');
  }
});

test('index.html contém seção de selos de uso e histórico recente sem HTML inseguro em src/', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  assert.ok(html.includes('id="usageVerdictSection"'));
  assert.ok(html.includes('id="usageVerdictGrid"'));
  assert.ok(html.includes('id="comparisonDeltaBar"'));
  assert.ok(html.includes('id="recentHistoryList"'));
  assert.ok(html.includes('id="recentExportCsvBtn"'));
  assert.ok(html.includes('id="recentExportJsonBtn"'));
  assert.ok(html.includes('id="recentClearHistoryBtn"'));
});
