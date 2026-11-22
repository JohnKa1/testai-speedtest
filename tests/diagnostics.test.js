import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { makeResult } from './helpers.js';
import {
  DIAGNOSIS_CATALOG,
  evaluateConnection
} from '../src/diagnostics/connection-diagnostics.js';
import { evaluateGamingReadiness } from '../src/diagnostics/gaming-analyzer.js';
import {
  evaluateDeviceComparison,
  evaluatePracticalCapabilities,
  evaluateSimpleStability
} from '../src/diagnostics/capability-advisor.js';
import { METRIC_STATUS } from '../src/utils/validators.js';

describe('TestAi — Diagnóstico de Rede, Cards Práticos e Gaming', () => {
  it('classifica conexão Gigabit saudável sem falsos alertas', () => {
    const res = makeResult();
    const diag = evaluateConnection(res);
    assert.equal(diag.code, DIAGNOSIS_CATALOG.EXCELLENT);
    assert.equal(diag.severity, 'good');
  });

  it('detecta bufferbloat severo sob carga', () => {
    const res = makeResult();
    res.metrics.downloadLatency = { value: 98, status: METRIC_STATUS.MEASURED };
    res.metrics.downloadLatencyDelta = { value: 91, status: METRIC_STATUS.MEASURED };

    const diag = evaluateConnection(res);
    assert.equal(diag.code, DIAGNOSIS_CATALOG.POSSIBLE_BUFFERBLOAT);
    assert.equal(diag.severity, 'danger');
  });

  it('separa conclusão de Downloads vs. Jogos/Chamadas nos Cards Inteligentes quando há 300 Mbps com bufferbloat', () => {
    const res = makeResult();
    res.metrics.download = { value: 310, status: METRIC_STATUS.MEASURED };
    res.metrics.downloadLatencyDelta = { value: 85, status: METRIC_STATUS.MEASURED };

    const cards = evaluatePracticalCapabilities(res);
    const downloads = cards.find((c) => c.id === 'downloads');
    const realtime = cards.find((c) => c.id === 'realtime');

    assert.equal(downloads?.tone, 'good');
    assert.equal(realtime?.tone, 'danger');
  });

  it('avalia estabilidade simples sem falso "Excelente" em medições parciais ou degradadas', () => {
    const healthy = makeResult();
    assert.deepEqual(evaluateSimpleStability(healthy, false), {
      label: 'Excelente',
      sub: 'Variação +5 ms',
      tone: 'good'
    });

    const partialFailedUpload = makeResult({ incomplete: true });
    partialFailedUpload.metrics.upload = { value: null, status: METRIC_STATUS.FAILED };
    assert.deepEqual(evaluateSimpleStability(partialFailedUpload, true), {
      label: 'Inconclusiva',
      sub: 'Medição parcial',
      tone: 'warning'
    });

    const diagPartial = evaluateConnection(partialFailedUpload);
    assert.equal(diagPartial.observed.includes('Falha Mbps'), false);
    assert.equal(diagPartial.observed.includes('N/D Mbps'), false);
    assert.ok(diagPartial.observed.includes('Upload: Falha'));

    const device = { manufacturer: 'Samsung', model: 'Galaxy A71', wifi: { generation: 'Wi-Fi 5' } };
    const compPartial = evaluateDeviceComparison(device, partialFailedUpload);
    assert.equal(compPartial.tiers.measured.includes('Falha Mbps'), false);
    assert.ok(compPartial.tiers.measured.includes('envio para a internet indisponível'));

    const moderate = makeResult();
    moderate.metrics.downloadLatencyDelta = { value: 42, status: METRIC_STATUS.MEASURED };
    assert.equal(evaluateSimpleStability(moderate, false).label, 'Moderada');

    const severe = makeResult();
    severe.metrics.uploadLatencyDelta = { value: 85, status: METRIC_STATUS.MEASURED };
    assert.equal(evaluateSimpleStability(severe, false).label, 'Sensível');
  });

  it('gera avisos claros de envio local para a internet sem culpar o provedor', () => {
    const partialUploadFail = makeResult({ incomplete: true });
    partialUploadFail.metrics.upload = { value: null, status: METRIC_STATUS.FAILED };
    partialUploadFail.stats.upload = { count: 0, min: 0, p50: 0, mean: 0, max: 0, cv: 0 };
    const diagUploadFail = evaluateConnection(partialUploadFail);
    assert.ok(diagUploadFail.title.includes('envio (upload) para a internet'));
    assert.ok(diagUploadFail.meaning.includes('dispositivo ou rede local'));

    const lowUploadOnly = makeResult({
      context: { linkType: 'wifi-5-6', contractedMbps: null, notes: '' }
    });
    lowUploadOnly.metrics.download = { value: 320, status: METRIC_STATUS.MEASURED };
    lowUploadOnly.metrics.upload = { value: 4.5, status: METRIC_STATUS.MEASURED };
    const diagLowUpload = evaluateConnection(lowUploadOnly);
    assert.equal(
      diagLowUpload.title,
      'Envio (upload) limitado do dispositivo/rede local para a internet'
    );

    const capsLowUpload = evaluatePracticalCapabilities(lowUploadOnly);
    const homeCard = capsLowUpload.find((c) => c.id === 'multi-device');
    assert.equal(homeCard?.status, 'Envio (Upload) Limitado');
    assert.ok(homeCard?.description.includes('dispositivo/rede local para a internet'));
  });

  it('aplica tone dinâmico em gêneros Gaming conforme a latência real', () => {
    const healthyGaming = evaluateGamingReadiness(makeResult());
    assert.ok(healthyGaming.genres.every((g) => g.tone === 'good'));

    const highPingResult = makeResult();
    highPingResult.metrics.ping = { value: 120, status: METRIC_STATUS.MEASURED };
    const highPingGaming = evaluateGamingReadiness(highPingResult);
    assert.equal(highPingGaming.genres[0].tone, 'danger');
    assert.equal(highPingGaming.genres[1].tone, 'warning');
  });
});
