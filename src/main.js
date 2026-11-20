/**
 * Controlador principal do TestAi.
 * Integra Modo Simples, Modo Avançado (NOC), Cards Inteligentes de Uso Prático
 * e Inteligência Comparativa de Capacidade de Dispositivos.
 */

import { SpeedTestService } from './services/speedtest.service.js';
import { evaluateConnection } from './diagnostics/connection-diagnostics.js';
import { evaluateGamingReadiness } from './diagnostics/gaming-analyzer.js';
import {
  evaluateDeviceComparison,
  evaluatePracticalCapabilities,
  getLiveCapabilityMilestone
} from './diagnostics/capability-advisor.js';
import { DeviceSpecsService } from './services/device-specs.service.js';
import { ThermometerComponent } from './components/thermometer.js';
import {
  renderHistoryChart,
  renderLatencyComparisonChart,
  renderThroughputChart
} from './components/charts.js';
import {
  appendHistoryRecord,
  buildTechnicalReportTxt,
  clearHistory,
  compareHistoryRecords,
  deleteHistoryRecord,
  exportHistoryCsv,
  exportHistoryJson,
  loadHistory,
  toHistoryRecord
} from './storage/history.storage.js';
import {
  clearElement,
  createEl,
  formatBytes,
  formatDateTime,
  formatDeltaMs,
  formatDuration,
  formatLatency,
  formatSpeed,
  setText
} from './utils/formatters.js';
import { isNonNegativeNumber, METRIC_STATUS } from './utils/validators.js';

const state = {
  uiMode: 'simple',
  lastResult: null,
  lastDiagnosis: null,
  lastGaming: null,
  selectedDevice: null,
  history: [],
  selectedForCompare: [],
  latestSnapshot: null,
  displayLoopId: null,
  lastFrameTime: 0,
  renderedSpeedMbps: 0,
  targetSpeedMbps: 0,
  activePhase: 'idle',
  diagDetailsExpanded: false
};

const thermometer = new ThermometerComponent();
const deviceService = new DeviceSpecsService();

const PHASE_LABELS = {
  idle: 'Aguardando',
  latency: 'Medindo Ping',
  download: 'Testando Download',
  upload: 'Testando Upload',
  completed: 'Concluído',
  cancelled: 'Cancelado',
  error: 'Falha'
};

// ============================================================================
// ALTERNÂNCIA ENTRE MODO SIMPLES E MODO AVANÇADO
// ============================================================================

function setUiMode(mode) {
  const normalized = mode === 'advanced' ? 'advanced' : 'simple';
  state.uiMode = normalized;
  document.body.dataset.uiMode = normalized;

  const simpleSec = document.getElementById('simpleExperience');
  const advSec = document.getElementById('advancedExperience');
  const simpleBtn = document.getElementById('modeSimpleBtn');
  const advBtn = document.getElementById('modeAdvancedBtn');

  simpleSec?.classList.toggle('hidden', normalized !== 'simple');
  advSec?.classList.toggle('hidden', normalized !== 'advanced');

  simpleBtn?.classList.toggle('active', normalized === 'simple');
  simpleBtn?.setAttribute('aria-pressed', String(normalized === 'simple'));

  advBtn?.classList.toggle('active', normalized === 'advanced');
  advBtn?.setAttribute('aria-pressed', String(normalized === 'advanced'));

  setText('modeBadge', normalized === 'simple' ? 'DIAGNÓSTICO INTELIGENTE' : 'NOC DIAGNOSTICS');
  setText(
    'brandSubtitle',
    normalized === 'simple'
      ? 'Descubra sua velocidade real e o que sua internet faz com estabilidade'
      : 'Telemetria de vazão, latência sob carga (bufferbloat) e diagnóstico técnico'
  );

  // Re-renderiza gráficos ao entrar no modo avançado para ajustar dimensões do Canvas
  if (normalized === 'advanced') {
    if (state.lastResult) {
      renderThroughputChart(
        document.getElementById('throughputChart'),
        state.lastResult.series.downloadPoints,
        state.lastResult.series.uploadPoints
      );
      renderLatencyComparisonChart(document.getElementById('latencyChart'), state.lastResult);
    } else {
      renderThroughputChart(document.getElementById('throughputChart'), [], []);
      renderLatencyComparisonChart(document.getElementById('latencyChart'), null);
    }
    renderHistoryChart(document.getElementById('historyChart'), state.history);
  }
}

// ============================================================================
// CÁLCULOS DE SUAVIZAÇÃO E MÉDIA
// ============================================================================

function computeSmoothedTarget(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const recent = points.slice(-3);
  const weights = [0.2, 0.3, 0.5].slice(-recent.length);
  const weightSum = weights.reduce((acc, w) => acc + w, 0);
  return recent.reduce((acc, pt, idx) => acc + pt.mbps * (weights[idx] / weightSum), 0);
}

function computeMeanMbps(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const sum = points.reduce((acc, pt) => acc + (Number.isFinite(pt.mbps) ? pt.mbps : 0), 0);
  return sum / points.length;
}

// ============================================================================
// LOOP DE FLUIDEZ VISUAL (60 FPS)
// ============================================================================

function startDisplayLoop() {
  stopDisplayLoop();
  state.renderedSpeedMbps = 0;
  state.targetSpeedMbps = 0;
  state.lastFrameTime = performance.now();

  const tick = (now) => {
    if (!speedTestService.isRunning()) {
      state.displayLoopId = null;
      return;
    }

    const dt = Math.min(64, Math.max(8, now - state.lastFrameTime));
    state.lastFrameTime = now;

    const alpha = 1 - Math.exp(-dt / 140);
    state.renderedSpeedMbps += (state.targetSpeedMbps - state.renderedSpeedMbps) * alpha;

    if (Math.abs(state.targetSpeedMbps - state.renderedSpeedMbps) < 0.05) {
      state.renderedSpeedMbps = state.targetSpeedMbps;
    }

    if (state.activePhase === 'download' || state.activePhase === 'upload') {
      const formatted = state.renderedSpeedMbps.toFixed(1);
      setText('currentSpeed', formatted);
      setText('simpleCurrentSpeed', formatted);
      thermometer.update(state.renderedSpeedMbps, state.activePhase);
    }

    state.displayLoopId = requestAnimationFrame(tick);
  };

  state.displayLoopId = requestAnimationFrame(tick);
}

function stopDisplayLoop() {
  if (state.displayLoopId !== null) {
    cancelAnimationFrame(state.displayLoopId);
    state.displayLoopId = null;
  }
}

// ============================================================================
// MOTOR DE MEDIÇÃO
// ============================================================================

const speedTestService = new SpeedTestService({
  onStart({ profile }) {
    state.latestSnapshot = null;
    state.activePhase = 'latency';
    resetTelemetryUI(profile.label);
    setRunningControls(true);
    hideStatusBanner();
    startDisplayLoop();
  },

  onProgress(payload) {
    state.latestSnapshot = payload;
    applyLiveTelemetryUpdate(payload);
  },

  onFinish(result) {
    stopDisplayLoop();
    setRunningControls(false);
    handleCompletedResult(result);
  },

  onCancel() {
    stopDisplayLoop();
    setRunningControls(false);
    state.activePhase = 'cancelled';
    setText('phaseLabel', PHASE_LABELS.cancelled);
    setText('simplePhaseLabel', PHASE_LABELS.cancelled);
    setText('simpleLiveHint', 'Medição cancelada. Clique em Iniciar Teste quando quiser recomeçar.');
    updateProgressBar(0, 'Teste cancelado pelo usuário.');
    showStatusBanner('warning', 'Execução interrompida manualmente.');
  },

  onError(errorPayload) {
    stopDisplayLoop();
    setRunningControls(false);
    state.activePhase = 'error';
    setText('phaseLabel', PHASE_LABELS.error);
    setText('simplePhaseLabel', PHASE_LABELS.error);
    updateProgressBar(0, 'Execução interrompida por falha.');
    showStatusBanner('danger', errorPayload.message);

    if (errorPayload.partialResult) {
      handleCompletedResult(errorPayload.partialResult, true);
    }
  }
});

// ============================================================================
// ATUALIZAÇÃO EM TEMPO REAL
// ============================================================================

function updateLoadedJitterUI(dlJitterMetric, ulJitterMetric) {
  const hasDl = dlJitterMetric?.status === METRIC_STATUS.MEASURED;
  const hasUl = ulJitterMetric?.status === METRIC_STATUS.MEASURED;

  if (!hasDl && !hasUl) {
    setText('loadedJitterValue', '—');
    setText('loadedJitterBreakdownMeta', '↓ — · ↑ — ms');
    return;
  }

  const maxVal = Math.max(hasDl ? dlJitterMetric.value : 0, hasUl ? ulJitterMetric.value : 0);
  setText('loadedJitterValue', `${maxVal.toFixed(1)} ms`);
  setText(
    'loadedJitterBreakdownMeta',
    `↓ ${hasDl ? dlJitterMetric.value.toFixed(1) : '—'} · ↑ ${hasUl ? ulJitterMetric.value.toFixed(1) : '—'} ms`
  );
}

function applyLiveTelemetryUpdate(payload) {
  const { phase, progressPercent, snapshot } = payload;

  const previousPhase = state.activePhase;
  state.activePhase = phase;

  if (previousPhase !== phase && (phase === 'download' || phase === 'upload')) {
    state.renderedSpeedMbps = 0;
  }

  const phaseText = PHASE_LABELS[phase] || phase;
  setText('phaseLabel', phaseText);
  setText('simplePhaseLabel', phaseText);

  const progressMessages = {
    latency: 'Medindo ping e estabilidade inicial...',
    download: 'Medindo velocidade de download e resposta sob carga...',
    upload: 'Medindo velocidade de upload e resposta sob carga...'
  };
  updateProgressBar(progressPercent, progressMessages[phase] || 'Executando telemetria...');

  const avgDownloadMbps = computeMeanMbps(snapshot.series.downloadPoints);
  const avgUploadMbps = computeMeanMbps(snapshot.series.uploadPoints);

  if (phase === 'download') {
    setText('liveMetricTitle', 'DOWNLOAD EM TEMPO REAL');
    setText('simpleHeroEyebrow', 'DOWNLOAD EM TEMPO REAL');
    const target = computeSmoothedTarget(snapshot.series.downloadPoints);
    if (isNonNegativeNumber(target)) {
      state.targetSpeedMbps = target;
      setText('simpleLiveHint', getLiveCapabilityMilestone(target, 'download'));
    }
    if (isNonNegativeNumber(avgDownloadMbps)) {
      setText('avgSpeed', avgDownloadMbps.toFixed(1));
      setText('simpleDownloadAvg', `Média: ${avgDownloadMbps.toFixed(1)} Mbps`);
    }
  } else if (phase === 'upload') {
    setText('liveMetricTitle', 'UPLOAD EM TEMPO REAL');
    setText('simpleHeroEyebrow', 'UPLOAD EM TEMPO REAL');
    const target = computeSmoothedTarget(snapshot.series.uploadPoints);
    if (isNonNegativeNumber(target)) {
      state.targetSpeedMbps = target;
      setText('simpleLiveHint', getLiveCapabilityMilestone(target, 'upload'));
    }
    if (isNonNegativeNumber(avgUploadMbps)) {
      setText('avgSpeed', avgUploadMbps.toFixed(1));
      setText('simpleUploadAvg', `Média: ${avgUploadMbps.toFixed(1)} Mbps`);
    }
  } else {
    setText('liveMetricTitle', 'SONDAGEM DE LATÊNCIA');
    setText('simpleHeroEyebrow', 'SONDAGEM DE LATÊNCIA');
    setText('simpleLiveHint', getLiveCapabilityMilestone(0, 'latency'));
  }

  setText(
    'avgBreakdown',
    `↓ ${isNonNegativeNumber(avgDownloadMbps) ? avgDownloadMbps.toFixed(1) : '—'} · ↑ ${isNonNegativeNumber(avgUploadMbps) ? avgUploadMbps.toFixed(1) : '—'} Mbps`
  );

  const m = snapshot.metrics;
  if (m.download.status === METRIC_STATUS.MEASURED) {
    setText('simpleDownloadVal', `${formatSpeed(m.download.value)} Mbps`);
  }
  if (m.upload.status === METRIC_STATUS.MEASURED) {
    const upFormatted = formatSpeed(m.upload.value);
    setText('uploadValue', upFormatted);
    setText('simpleUploadVal', `${upFormatted} Mbps`);
  }
  if (m.ping.status === METRIC_STATUS.MEASURED) {
    const pingFormatted = formatLatency(m.ping.value);
    setText('pingValue', pingFormatted);
    setText('simplePingVal', `${pingFormatted} ms`);
  }
  if (m.jitter.status === METRIC_STATUS.MEASURED) {
    setText('jitterValue', formatLatency(m.jitter.value, 1));
  }
  if (m.downloadLatency.status === METRIC_STATUS.MEASURED) {
    setText('downloadLatencyValue', formatLatency(m.downloadLatency.value));
  }
  if (m.uploadLatency.status === METRIC_STATUS.MEASURED) {
    setText('uploadLatencyValue', formatLatency(m.uploadLatency.value));
  }
  updateLoadedJitterUI(m.downloadJitter, m.uploadJitter);

  renderThroughputChart(
    document.getElementById('throughputChart'),
    snapshot.series.downloadPoints,
    snapshot.series.uploadPoints
  );
}

// ============================================================================
// CONSOLIDAÇÃO FINAL
// ============================================================================

function computeSimpleStabilityLabel(result) {
  const m = result.metrics;
  const dlDelta =
    m.downloadLatencyDelta?.status === METRIC_STATUS.MEASURED ? m.downloadLatencyDelta.value : 0;
  const ulDelta =
    m.uploadLatencyDelta?.status === METRIC_STATUS.MEASURED ? m.uploadLatencyDelta.value : 0;
  const jitter = m.jitter?.status === METRIC_STATUS.MEASURED ? m.jitter.value : 0;
  const maxDelta = Math.max(dlDelta, ulDelta);

  if (maxDelta >= 60 || jitter > 20) {
    return { label: 'Sensível', sub: `+${Math.round(maxDelta)} ms sob carga` };
  }
  if (maxDelta >= 30 || jitter > 12) {
    return { label: 'Moderada', sub: `+${Math.round(maxDelta)} ms sob carga` };
  }
  return { label: 'Excelente', sub: `Variação +${Math.round(maxDelta)} ms` };
}

function handleCompletedResult(result, isPartial = false) {
  const diagnosis = evaluateConnection(result);
  const gaming = evaluateGamingReadiness(result);
  const capabilities = evaluatePracticalCapabilities(result);

  state.lastResult = result;
  state.lastDiagnosis = diagnosis;
  state.lastGaming = gaming;
  state.activePhase = isPartial ? 'error' : 'completed';

  const m = result.metrics;
  const dlFinal = formatSpeed(m.download.value, 1, m.download.status);
  const ulFinal = formatSpeed(m.upload.value, 1, m.upload.status);
  const pingFinal = formatLatency(m.ping.value, 0, m.ping.status);

  const avgDl = computeMeanMbps(result.series.downloadPoints);
  const avgUl = computeMeanMbps(result.series.uploadPoints);

  // Atualiza Modo Simples
  setText('simpleHeroEyebrow', 'DOWNLOAD MEDIDO');
  setText('simplePhaseLabel', isPartial ? 'Parcial' : 'Concluído');
  setText('simpleCurrentSpeed', dlFinal);
  setText('simpleDownloadVal', `${dlFinal} Mbps`);
  setText('simpleUploadVal', `${ulFinal} Mbps`);
  setText('simplePingVal', `${pingFinal} ms`);
  setText('simpleDownloadAvg', `Média: ${isNonNegativeNumber(avgDl) ? avgDl.toFixed(1) : '—'} Mbps`);
  setText('simpleUploadAvg', `Média: ${isNonNegativeNumber(avgUl) ? avgUl.toFixed(1) : '—'} Mbps`);

  const stability = computeSimpleStabilityLabel(result);
  setText('simpleStabilityVal', stability.label);
  setText('simpleStabilitySub', stability.sub);
  setText('simpleLiveHint', diagnosis.summary);

  renderSimpleVerdict(diagnosis);
  renderCapabilitiesGrid(capabilities);

  // Atualiza Modo Avançado
  setText('phaseLabel', isPartial ? 'Parcial' : 'Concluído');
  setText('liveMetricTitle', 'DOWNLOAD FINAL (P90)');
  setText('currentSpeed', dlFinal);
  setText('uploadValue', ulFinal);
  setText('pingValue', pingFinal);
  setText('jitterValue', formatLatency(m.jitter.value, 1, m.jitter.status));
  setText('downloadLatencyValue', formatLatency(m.downloadLatency.value, 0, m.downloadLatency.status));
  setText('uploadLatencyValue', formatLatency(m.uploadLatency.value, 0, m.uploadLatency.status));
  updateLoadedJitterUI(m.downloadJitter, m.uploadJitter);

  setText('downloadLatencyDeltaMeta', `ms (${formatDeltaMs(m.downloadLatencyDelta.value)})`);
  setText('uploadLatencyDeltaMeta', `ms (${formatDeltaMs(m.uploadLatencyDelta.value)})`);

  setText(
    'avgSpeed',
    formatSpeed(avgDl, 1, isNonNegativeNumber(avgDl) ? METRIC_STATUS.MEASURED : METRIC_STATUS.UNAVAILABLE)
  );
  setText(
    'avgBreakdown',
    `↓ ${formatSpeed(avgDl, 1, isNonNegativeNumber(avgDl) ? METRIC_STATUS.MEASURED : METRIC_STATUS.UNAVAILABLE)} · ↑ ${formatSpeed(avgUl, 1, isNonNegativeNumber(avgUl) ? METRIC_STATUS.MEASURED : METRIC_STATUS.UNAVAILABLE)} Mbps`
  );

  thermometer.update(m.download.value ?? 0, 'completed');

  if (!isPartial) {
    updateProgressBar(100, `Diagnóstico concluído em ${formatDuration(result.durationMs)}.`);
  }

  setText(
    'throughputChartMeta',
    `↓ ${result.series.downloadPoints.length} pts · ↑ ${result.series.uploadPoints.length} pts`
  );
  renderThroughputChart(
    document.getElementById('throughputChart'),
    result.series.downloadPoints,
    result.series.uploadPoints
  );

  setText(
    'latencyChartMeta',
    `Ocioso ${formatLatency(m.ping.value)} ms · ↓ ${formatDeltaMs(m.downloadLatencyDelta.value)} · ↑ ${formatDeltaMs(m.uploadLatencyDelta.value)}`
  );
  renderLatencyComparisonChart(document.getElementById('latencyChart'), result);

  renderDiagnosticsAndGaming(diagnosis, gaming);
  renderTechnicalPanel(result);

  // Atualiza comparação com aparelho se já houver dispositivo selecionado
  if (state.selectedDevice) {
    renderDeviceComparisonPanel(state.selectedDevice);
  }

  const record = toHistoryRecord(result, diagnosis, gaming);
  state.history = appendHistoryRecord(record);
  renderHistoryPanel();
}

// ============================================================================
// RENDERIZAÇÃO DO MODO SIMPLES & CARDS INTELIGENTES
// ============================================================================

function renderSimpleVerdict(diagnosis) {
  const card = document.getElementById('simpleVerdictCard');
  const badge = document.getElementById('simpleVerdictBadge');
  if (!card) return;

  card.classList.remove('hidden', 'severity-good', 'severity-warning', 'severity-danger');
  card.classList.add(`severity-${diagnosis.severity}`);

  if (badge) {
    const labels = {
      good: 'CONEXÃO SAUDÁVEL',
      warning: 'PONTO DE ATENÇÃO',
      danger: 'GARGALO DETECTADO'
    };
    badge.textContent = labels[diagnosis.severity] || 'DIAGNÓSTICO';
  }
  setText('simpleVerdictTitle', diagnosis.title);
  setText('simpleVerdictSummary', diagnosis.summary);
}

function renderCapabilitiesGrid(capabilities) {
  const grid = document.getElementById('capabilitiesGrid');
  if (!grid) return;

  clearElement(grid);

  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    const empty = createEl(
      'div',
      'card empty-state',
      'Não há dados suficientes para avaliar os cenários de uso.'
    );
    grid.appendChild(empty);
    return;
  }

  capabilities.forEach((item) => {
    const card = createEl('article', `card capability-card tone-${item.tone}`);
    const top = createEl('div', 'capability-card-top');
    top.appendChild(createEl('h3', 'capability-title', item.title));
    top.appendChild(createEl('span', `capability-pill tone-${item.tone}`, item.status));
    card.appendChild(top);
    card.appendChild(createEl('p', 'capability-desc', item.description));
    grid.appendChild(card);
  });
}

// ============================================================================
// INTELIGÊNCIA DE DISPOSITIVOS
// ============================================================================

function renderPopularDeviceChips() {
  const container = document.getElementById('deviceQuickChips');
  if (!container) return;

  clearElement(container);
  const models = deviceService.getPopularModels();
  models.forEach((dev) => {
    const label = `${dev.manufacturer} ${dev.model}`;
    const btn = createEl('button', 'chip-btn', label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const input = document.getElementById('deviceQueryInput');
      if (input) input.value = label;
      handleDeviceLookup(label);
    });
    container.appendChild(btn);
  });
}

function showDeviceFeedback(tone, text) {
  const el = document.getElementById('deviceFeedback');
  if (!el) return;
  el.className = `device-feedback tone-${tone}`;
  el.textContent = text;
  el.classList.remove('hidden');
}

function hideDeviceFeedback() {
  const el = document.getElementById('deviceFeedback');
  if (el) el.classList.add('hidden');
}

function renderDeviceComparisonPanel(device) {
  const panel = document.getElementById('deviceResultPanel');
  if (!panel || !device) return;

  const comparison = evaluateDeviceComparison(device, state.lastResult);
  if (!comparison) return;

  clearElement(panel);
  panel.classList.remove('hidden');

  // Cabeçalho do dispositivo com selo de categoria e status de teste
  const header = createEl('div', 'device-result-header');
  const titleBox = createEl('div', '');
  titleBox.appendChild(createEl('h3', 'device-result-title', comparison.deviceName));
  titleBox.appendChild(
    createEl('p', 'device-result-variant', `Variante: ${comparison.regionalVariant}`)
  );
  header.appendChild(titleBox);

  const badgesWrap = createEl('div', 'device-header-badges');
  if (comparison.category) {
    badgesWrap.appendChild(
      createEl('span', `capability-pill tone-${comparison.category.tone}`, comparison.category.badge)
    );
  }
  badgesWrap.appendChild(
    createEl('span', `capability-pill tone-${comparison.verdictTone}`, comparison.verdictBadge)
  );
  header.appendChild(badgesWrap);
  panel.appendChild(header);

  // Cards de Média Real por Banda Wi-Fi (2,4 GHz, 5 GHz e 6 GHz)
  const bandsSection = createEl('div', 'device-bands-section');
  const bandsHeader = createEl('div', 'device-bands-header');
  bandsHeader.appendChild(
    createEl('h4', 'device-bands-title', 'Média Real Esperada por Banda Wi-Fi')
  );
  bandsHeader.appendChild(
    createEl(
      'span',
      'device-bands-subtitle',
      'Estimativa prática em Mbps conforme o rádio do smartphone'
    )
  );
  bandsSection.appendChild(bandsHeader);

  const bandsGrid = createEl('div', 'device-bands-grid');
  const bandEntries = [
    comparison.wifiBandAverages.band24,
    comparison.wifiBandAverages.band5,
    comparison.wifiBandAverages.band6
  ];

  bandEntries.forEach((b) => {
    const card = createEl('div', `device-band-card ${b.supported ? 'supported' : 'unsupported'}`);
    const top = createEl('div', 'device-band-top');
    top.appendChild(createEl('span', 'device-band-label', b.label));
    top.appendChild(
      createEl('span', `device-band-pill ${b.supported ? 'tone-good' : 'tone-muted'}`, b.status)
    );
    card.appendChild(top);

    const valBox = createEl('div', 'device-band-val-box');
    valBox.appendChild(createEl('span', 'device-band-speed', b.speedRange));
    if (b.typicalSpeed && b.supported) {
      valBox.appendChild(
        createEl('span', 'device-band-typical', `(média típica ${b.typicalSpeed})`)
      );
    }
    card.appendChild(valBox);
    card.appendChild(createEl('p', 'device-band-note', b.note));
    bandsGrid.appendChild(card);
  });
  bandsSection.appendChild(bandsGrid);
  panel.appendChild(bandsSection);

  // Distinção obrigatória das 3 camadas: Teórico vs. Favorável vs. Medido
  const tiersGrid = createEl('div', 'device-tiers-grid');

  const tierItems = [
    {
      label: '1. Especificação Teórica Documentada',
      value: comparison.tiers.theoretical
    },
    {
      label: '2. Estimativa em Condições Favoráveis',
      value: comparison.tiers.favorableEstimate
    },
    {
      label: '3. Velocidade Medida no TestAi',
      value: comparison.tiers.measured
    }
  ];

  tierItems.forEach((t) => {
    const box = createEl('div', 'device-tier-box');
    box.appendChild(createEl('span', 'device-tier-label', t.label));
    box.appendChild(createEl('strong', 'device-tier-val', t.value));
    tiersGrid.appendChild(box);
  });
  panel.appendChild(tiersGrid);

  // Ficha técnica resumida: Conectividade e Categoria do Aparelho
  const specsGrid = createEl('div', 'device-specs-grid');
  const specRows = [
    ['Padrão Wi-Fi & Redes', comparison.compatibilitySummary],
    [
      'Classificação do Aparelho',
      `${comparison.category.tier} — ${comparison.category.summary}`
    ]
  ];

  specRows.forEach(([k, v]) => {
    const item = createEl('div', 'tech-meta-item');
    item.appendChild(createEl('span', 'tech-meta-key', k));
    item.appendChild(createEl('span', 'tech-meta-val', v));
    specsGrid.appendChild(item);
  });
  panel.appendChild(specsGrid);

  // Análise técnica explicativa
  const analysisBox = createEl('div', 'method-disclaimer');
  analysisBox.appendChild(createEl('strong', '', 'Análise comparativa: '));
  analysisBox.appendChild(document.createTextNode(comparison.analysis));
  panel.appendChild(analysisBox);

  // Proveniência oficial dos dados
  panel.appendChild(
    createEl(
      'p',
      'device-provenance mono',
      `Fonte: ${comparison.source} · Revisão: ${comparison.dataVersion}`
    )
  );
}

async function handleDeviceLookup(rawQuery) {
  const btn = document.getElementById('deviceSearchBtn');
  if (btn) btn.disabled = true;

  const lookup = await deviceService.lookupDevice(rawQuery);
  if (btn) btn.disabled = false;

  if (lookup.status === 'found' && lookup.device) {
    state.selectedDevice = lookup.device;
    hideDeviceFeedback();
    renderDeviceComparisonPanel(lookup.device);
    return;
  }

  state.selectedDevice = null;
  const panel = document.getElementById('deviceResultPanel');
  if (panel) panel.classList.add('hidden');
  showDeviceFeedback('warning', lookup.message || 'Dispositivo não encontrado.');
}

// ============================================================================
// RENDERIZAÇÃO ADAPTATIVA DO DIAGNÓSTICO + GAMING (MODO AVANÇADO)
// ============================================================================

function syncDiagnosticDetailsVisibility() {
  const gridEl = document.getElementById('diagStructuredGrid');
  const toggleBtn = document.getElementById('diagDetailsToggle');
  if (!gridEl || !toggleBtn) return;

  gridEl.classList.toggle('hidden', !state.diagDetailsExpanded);
  toggleBtn.setAttribute('aria-expanded', String(state.diagDetailsExpanded));
  toggleBtn.textContent = state.diagDetailsExpanded
    ? 'Ocultar detalhamento técnico'
    : 'Ver detalhamento técnico completo';
}

function renderDiagnosticsAndGaming(diagnosis, gaming) {
  const emptyEl = document.getElementById('diagnosticEmpty');
  const stackEl = document.getElementById('diagnosticStack');
  const cardEl = document.getElementById('diagnosticCard');
  const gridEl = document.getElementById('diagStructuredGrid');
  const secEl = document.getElementById('diagSecondaryFindings');
  const badgeEl = document.getElementById('diagSeverityBadge');
  const toggleBtn = document.getElementById('diagDetailsToggle');

  if (!stackEl || !cardEl || !gridEl) return;

  emptyEl?.classList.add('hidden');
  stackEl.classList.remove('hidden');

  cardEl.classList.remove('severity-good', 'severity-warning', 'severity-danger');
  cardEl.classList.add(`severity-${diagnosis.severity}`);

  if (badgeEl) {
    const labels = {
      good: 'SAUDÁVEL',
      warning: 'ATENÇÃO',
      danger: 'CRÍTICO'
    };
    badgeEl.textContent = labels[diagnosis.severity] || 'ANÁLISE';
  }

  setText('diagTitle', diagnosis.title);
  setText('diagSummary', diagnosis.summary);

  clearElement(gridEl);

  const blocks = [
    { title: '1. O que foi observado', type: 'text', content: diagnosis.observed },
    { title: '2. Métricas que fundamentam', type: 'list', items: diagnosis.basisMetrics },
    { title: '3. O que isso significa na prática', type: 'text', content: diagnosis.meaning },
    { title: '4. Causas prováveis (hipóteses)', type: 'list', items: diagnosis.probableCauses },
    { title: '5. O que você pode fazer', type: 'list', items: diagnosis.userActions },
    { title: '6. Teste adicional confirmatório', type: 'text', content: diagnosis.confirmatoryTest }
  ];

  blocks.forEach((block) => {
    const box = createEl('div', 'diag-block');
    box.appendChild(createEl('h3', 'diag-block-title', block.title));

    if (block.type === 'list') {
      const ul = createEl('ul', 'diag-list');
      block.items.forEach((item) => ul.appendChild(createEl('li', '', item)));
      box.appendChild(ul);
    } else {
      box.appendChild(createEl('p', 'diag-block-text', block.content));
    }

    gridEl.appendChild(box);
  });

  const isHealthy = diagnosis.severity === 'good';
  state.diagDetailsExpanded = !isHealthy;
  if (toggleBtn) {
    toggleBtn.classList.toggle('hidden', !isHealthy);
  }
  syncDiagnosticDetailsVisibility();

  if (secEl) {
    clearElement(secEl);
    if (diagnosis.secondaryFindings && diagnosis.secondaryFindings.length > 0) {
      secEl.classList.remove('hidden');
      secEl.appendChild(createEl('h3', 'secondary-title', 'Indicadores secundários observados'));
      diagnosis.secondaryFindings.forEach((sf) => {
        const item = createEl('div', `secondary-item severity-${sf.severity}`);
        item.appendChild(createEl('strong', '', sf.title));
        item.appendChild(createEl('p', '', sf.summary));
        secEl.appendChild(item);
      });
    } else {
      secEl.classList.add('hidden');
    }
  }

  const gamingCardEl = document.getElementById('gamingCard');
  const pillarsEl = document.getElementById('gamingPillarsGrid');
  const genresEl = document.getElementById('gamingGenresGrid');
  const gamingBadgeEl = document.getElementById('gamingVerdictBadge');

  if (!gamingCardEl || !pillarsEl || !genresEl) return;

  gamingCardEl.classList.remove('severity-good', 'severity-warning', 'severity-danger');
  gamingCardEl.classList.add(`severity-${gaming.severity}`);

  if (gamingBadgeEl) {
    gamingBadgeEl.textContent = `GAMING · ${gaming.badge}`;
  }
  setText('gamingTitle', gaming.title);
  setText('gamingSummary', gaming.summary);

  clearElement(pillarsEl);
  gaming.pillars.forEach((p) => {
    const card = createEl('div', 'gaming-pillar');
    const top = createEl('div', 'gaming-pillar-top');
    top.appendChild(createEl('span', 'gaming-pillar-label', p.label));
    top.appendChild(createEl('span', 'gaming-pillar-status', p.status));
    card.appendChild(top);
    card.appendChild(createEl('div', 'gaming-pillar-value mono', p.value));
    card.appendChild(createEl('p', 'gaming-pillar-detail', p.detail));
    pillarsEl.appendChild(card);
  });

  clearElement(genresEl);
  gaming.genres.forEach((g) => {
    const box = createEl('div', 'gaming-genre');
    box.appendChild(createEl('div', 'gaming-genre-title', g.category));
    box.appendChild(createEl('div', 'gaming-genre-fit', g.fit));
    box.appendChild(createEl('p', 'gaming-genre-note', g.note));
    genresEl.appendChild(box);
  });
}

function renderTechnicalPanel(result) {
  const tbody = document.getElementById('techMetricsBody');
  const ctxGrid = document.getElementById('techContextGrid');
  if (!tbody || !ctxGrid) return;

  setText('techSessionId', `Sessão: ${result.id}`);
  clearElement(tbody);

  const m = result.metrics;
  const s = result.stats;

  const formatDist = (statObj, decimals = 1) => {
    if (!statObj) return '—';
    return `${statObj.min.toFixed(decimals)} / ${statObj.p50.toFixed(decimals)} / ${statObj.p90.toFixed(decimals)} / ${statObj.max.toFixed(decimals)}`;
  };

  const statusLabels = {
    [METRIC_STATUS.MEASURED]: 'Medido',
    [METRIC_STATUS.UNAVAILABLE]: 'N/D',
    [METRIC_STATUS.FAILED]: 'Falha',
    [METRIC_STATUS.PENDING]: 'Pendente'
  };

  const rows = [
    {
      name: 'Download (P90)',
      value: `${formatSpeed(m.download.value, 2, m.download.status)} Mbps`,
      samples: s.download?.count ?? 0,
      dist: formatDist(s.download, 1),
      status: statusLabels[m.download.status]
    },
    {
      name: 'Upload (P90)',
      value: `${formatSpeed(m.upload.value, 2, m.upload.status)} Mbps`,
      samples: s.upload?.count ?? 0,
      dist: formatDist(s.upload, 1),
      status: statusLabels[m.upload.status]
    },
    {
      name: 'Ping Ocioso (P50)',
      value: `${formatLatency(m.ping.value, 1, m.ping.status)} ms`,
      samples: s.unloadedLatency?.count ?? 0,
      dist: formatDist(s.unloadedLatency, 1),
      status: statusLabels[m.ping.status]
    },
    {
      name: 'Jitter Ocioso',
      value: `${formatLatency(m.jitter.value, 2, m.jitter.status)} ms`,
      samples: s.unloadedLatency?.count ?? 0,
      dist: '—',
      status: statusLabels[m.jitter.status]
    },
    {
      name: 'Latência sob Download (P50)',
      value: `${formatLatency(m.downloadLatency.value, 1, m.downloadLatency.status)} ms (${formatDeltaMs(m.downloadLatencyDelta.value)})`,
      samples: s.downloadLatency?.count ?? 0,
      dist: formatDist(s.downloadLatency, 1),
      status: statusLabels[m.downloadLatency.status]
    },
    {
      name: 'Latência sob Upload (P50)',
      value: `${formatLatency(m.uploadLatency.value, 1, m.uploadLatency.status)} ms (${formatDeltaMs(m.uploadLatencyDelta.value)})`,
      samples: s.uploadLatency?.count ?? 0,
      dist: formatDist(s.uploadLatency, 1),
      status: statusLabels[m.uploadLatency.status]
    },
    {
      name: 'Jitter sob Download',
      value: `${formatLatency(m.downloadJitter.value, 2, m.downloadJitter.status)} ms`,
      samples: s.downloadLatency?.count ?? 0,
      dist: '—',
      status: statusLabels[m.downloadJitter.status]
    },
    {
      name: 'Jitter sob Upload',
      value: `${formatLatency(m.uploadJitter.value, 2, m.uploadJitter.status)} ms`,
      samples: s.uploadLatency?.count ?? 0,
      dist: '—',
      status: statusLabels[m.uploadJitter.status]
    }
  ];

  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.appendChild(createEl('td', '', r.name));
    tr.appendChild(createEl('td', 'mono', r.value));
    tr.appendChild(createEl('td', 'mono', String(r.samples)));
    tr.appendChild(createEl('td', 'mono', r.dist));
    tr.appendChild(createEl('td', '', r.status));
    tbody.appendChild(tr);
  });

  clearElement(ctxGrid);
  const metaItems = [
    ['Data / Hora', formatDateTime(result.timestamp)],
    ['Duração Total', formatDuration(result.durationMs)],
    ['Dados Download', formatBytes(result.transfer.totalDownloadBytes)],
    ['Dados Upload', formatBytes(result.transfer.totalUploadBytes)],
    ['Perfil Executado', result.profile.label],
    ['Meio Declarado', result.context.linkType]
  ];

  metaItems.forEach(([k, v]) => {
    const item = createEl('div', 'tech-meta-item');
    item.appendChild(createEl('span', 'tech-meta-key', k));
    item.appendChild(createEl('span', 'tech-meta-val mono', v));
    ctxGrid.appendChild(item);
  });
}

// ============================================================================
// HISTÓRICO E COMPARAÇÃO
// ============================================================================

function renderHistoryPanel() {
  const tbody = document.getElementById('historyTableBody');
  const compBox = document.getElementById('comparisonBox');
  const chartCanvas = document.getElementById('historyChart');

  renderHistoryChart(chartCanvas, state.history);

  if (!tbody) return;
  clearElement(tbody);

  if (state.history.length === 0) {
    const tr = document.createElement('tr');
    const td = createEl('td', 'muted-cell', 'Nenhum registro salvo no histórico local.');
    td.colSpan = 8;
    tr.appendChild(td);
    tbody.appendChild(tr);
    compBox?.classList.add('hidden');
    return;
  }

  state.history.forEach((rec) => {
    const tr = document.createElement('tr');

    const checkTd = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.ariaLabel = `Selecionar teste de ${formatDateTime(rec.timestamp)} para comparação`;
    cb.checked = state.selectedForCompare.includes(rec.id);
    cb.addEventListener('change', () => toggleCompareSelection(rec.id));
    checkTd.appendChild(cb);
    tr.appendChild(checkTd);

    tr.appendChild(createEl('td', 'mono', formatDateTime(rec.timestamp)));
    tr.appendChild(createEl('td', 'mono', `${formatSpeed(rec.downloadMbps)} Mbps`));
    tr.appendChild(createEl('td', 'mono', `${formatSpeed(rec.uploadMbps)} Mbps`));
    tr.appendChild(
      createEl('td', 'mono', `${formatLatency(rec.pingMs)} ms / ${formatLatency(rec.jitterMs, 1)} ms`)
    );
    tr.appendChild(
      createEl(
        'td',
        'mono',
        `${formatDeltaMs(rec.downloadLatencyDeltaMs)} · ${formatDeltaMs(rec.uploadLatencyDeltaMs)}`
      )
    );
    tr.appendChild(createEl('td', '', rec.diagnosisTitle));

    const actionTd = document.createElement('td');
    const delBtn = createEl('button', 'btn-mini-danger', 'Excluir');
    delBtn.type = 'button';
    delBtn.addEventListener('click', () => {
      state.history = deleteHistoryRecord(rec.id);
      state.selectedForCompare = state.selectedForCompare.filter((id) => id !== rec.id);
      renderHistoryPanel();
    });
    actionTd.appendChild(delBtn);
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  });

  if (compBox) {
    if (state.selectedForCompare.length === 2) {
      const [recA, recB] = state.selectedForCompare
        .map((id) => state.history.find((r) => r.id === id))
        .filter(Boolean);

      if (recA && recB) {
        const [newer, older] =
          new Date(recA.timestamp) >= new Date(recB.timestamp) ? [recA, recB] : [recB, recA];
        const comp = compareHistoryRecords(newer, older);

        clearElement(compBox);
        compBox.classList.remove('hidden');
        compBox.appendChild(
          createEl(
            'strong',
            '',
            `Comparação: ${formatDateTime(newer.timestamp)} vs. ${formatDateTime(older.timestamp)}`
          )
        );

        const formatSigned = (val, unit, dec = 1) => {
          if (!Number.isFinite(val)) return 'N/D';
          const sign = val > 0 ? '+' : '';
          return `${sign}${val.toFixed(dec)} ${unit}`;
        };

        compBox.appendChild(
          createEl(
            'p',
            'mono',
            `Download: ${formatSigned(comp.downloadDiffMbps, 'Mbps')} · Upload: ${formatSigned(comp.uploadDiffMbps, 'Mbps')} · Ping: ${formatSigned(comp.pingDiffMs, 'ms', 0)} · Jitter: ${formatSigned(comp.jitterDiffMs, 'ms', 1)}`
          )
        );
        return;
      }
    }
    compBox.classList.add('hidden');
  }
}

function toggleCompareSelection(id) {
  if (state.selectedForCompare.includes(id)) {
    state.selectedForCompare = state.selectedForCompare.filter((item) => item !== id);
  } else {
    state.selectedForCompare = [...state.selectedForCompare.slice(-1), id];
  }
  renderHistoryPanel();
}

// ============================================================================
// CONTROLES DE UI E HELPERS
// ============================================================================

function triggerStartOrCancel() {
  if (speedTestService.isRunning()) {
    speedTestService.cancel();
    return;
  }

  const profileId = document.getElementById('profileSelect')?.value || 'standard';
  const linkType = document.getElementById('linkTypeSelect')?.value || 'nao-informado';
  const contractedRaw = Number(document.getElementById('contractedInput')?.value);
  const notes = document.getElementById('techNotesInput')?.value || '';

  speedTestService.start(profileId, {
    linkType,
    contractedMbps:
      Number.isFinite(contractedRaw) && contractedRaw > 0 && contractedRaw <= 100000
        ? contractedRaw
        : null,
    notes
  });
}

function syncContextIndicator() {
  const toggleBtn = document.getElementById('contextToggleBtn');
  const drawer = document.getElementById('contextDrawer');
  const linkVal = document.getElementById('linkTypeSelect')?.value || 'nao-informado';
  const contractedVal = Number(document.getElementById('contractedInput')?.value);

  if (!toggleBtn || !drawer) return;

  const isOpen = !drawer.classList.contains('hidden');
  const hasContext =
    linkVal !== 'nao-informado' || (Number.isFinite(contractedVal) && contractedVal > 0);

  toggleBtn.classList.toggle('has-context', hasContext);
  if (isOpen) {
    toggleBtn.textContent = 'Ocultar contexto';
  } else {
    toggleBtn.textContent = hasContext ? 'Contexto definido' : '+ Contexto opcional';
  }
}

function resetTelemetryUI(profileLabel) {
  // Modo Simples
  setText('simpleHeroEyebrow', 'INICIANDO TESTE');
  setText('simplePhaseLabel', 'Preparando');
  setText('simpleCurrentSpeed', '0.0');
  setText('simpleDownloadVal', '—');
  setText('simpleUploadVal', '—');
  setText('simplePingVal', '—');
  setText('simpleStabilityVal', '—');
  setText('simpleStabilitySub', 'Sob uso intenso');
  setText('simpleDownloadAvg', 'Média: —');
  setText('simpleUploadAvg', 'Média: —');
  setText('simpleLiveHint', 'Iniciando sondagem com a borda mais próxima...');
  document.getElementById('simpleVerdictCard')?.classList.add('hidden');

  // Modo Avançado
  setText('currentSpeed', '0.0');
  setText('liveMetricTitle', 'VAZÃO ATUAL');
  setText('phaseLabel', 'Iniciando');
  setText('avgSpeed', '—');
  setText('avgBreakdown', '↓ — · ↑ — Mbps');

  [
    'uploadValue',
    'pingValue',
    'jitterValue',
    'downloadLatencyValue',
    'uploadLatencyValue',
    'loadedJitterValue'
  ].forEach((id) => setText(id, '—'));

  setText('downloadLatencyDeltaMeta', 'ms carregado');
  setText('uploadLatencyDeltaMeta', 'ms carregado');
  setText('loadedJitterBreakdownMeta', '↓ — · ↑ — ms');

  thermometer.reset();
  updateProgressBar(2, `Inicializando perfil ${profileLabel}...`);

  renderThroughputChart(document.getElementById('throughputChart'), [], []);
  renderLatencyComparisonChart(document.getElementById('latencyChart'), null);
}

function setRunningControls(isRunning) {
  const btnAdv = document.getElementById('startBtnAdv');
  const btnSimple = document.getElementById('startBtnSimple');
  const profileSel = document.getElementById('profileSelect');
  const panel = document.getElementById('telemetryPanel');
  const phaseBadge = document.getElementById('phaseLabel');
  const simplePhaseBadge = document.getElementById('simplePhaseLabel');
  const thermoFill = document.getElementById('thermoFill');

  if (panel) panel.setAttribute('aria-busy', String(isRunning));
  if (profileSel) profileSel.disabled = isRunning;

  phaseBadge?.classList.toggle('is-live', isRunning);
  simplePhaseBadge?.classList.toggle('is-live', isRunning);
  thermoFill?.classList.toggle('is-streaming', isRunning);

  if (btnAdv) {
    btnAdv.textContent = isRunning ? 'Cancelar Medição' : 'Iniciar Diagnóstico';
    btnAdv.classList.toggle('cancel', isRunning);
  }
  if (btnSimple) {
    btnSimple.textContent = isRunning ? 'Cancelar Teste' : 'Iniciar Teste';
    btnSimple.classList.toggle('cancel', isRunning);
  }
}

function updateProgressBar(percent, label) {
  const bar = document.getElementById('progressBar');
  const section = document.getElementById('progressSection');

  if (bar) bar.style.width = `${percent}%`;
  if (section) {
    section.setAttribute('aria-valuenow', String(percent));
    section.setAttribute('aria-valuetext', label);
  }
  setText('progressLabel', label);
  setText('progressPercent', `${percent}%`);
}

function showStatusBanner(severity, message) {
  const banner = document.getElementById('statusBanner');
  if (!banner) return;
  banner.className = `status-banner severity-${severity}`;
  banner.textContent = message;
  banner.classList.remove('hidden');
}

function hideStatusBanner() {
  const banner = document.getElementById('statusBanner');
  if (banner) banner.classList.add('hidden');
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function updateOnlineIndicator() {
  const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
  const dot = document.getElementById('networkDot');
  if (dot) {
    dot.classList.toggle('online', online);
    dot.classList.toggle('offline', !online);
  }
  setText('networkStatusText', online ? 'Online' : 'Offline');
}

function setupTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;

      tabButtons.forEach((b) => {
        const active = b.dataset.tab === target;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', String(active));
      });

      tabPanels.forEach((panel) => {
        const match = panel.id === `panel-${target}`;
        panel.classList.toggle('active', match);
        panel.classList.toggle('hidden', !match);
      });

      if (target === 'history') {
        renderHistoryChart(document.getElementById('historyChart'), state.history);
      }
    });
  });
}

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  state.history = loadHistory();
  setUiMode('simple');
  setupTabs();
  updateOnlineIndicator();
  renderHistoryPanel();
  renderPopularDeviceChips();

  window.addEventListener('online', updateOnlineIndicator);
  window.addEventListener('offline', updateOnlineIndicator);

  window.addEventListener('resize', () => {
    if (state.uiMode === 'advanced') {
      if (state.lastResult) {
        renderThroughputChart(
          document.getElementById('throughputChart'),
          state.lastResult.series.downloadPoints,
          state.lastResult.series.uploadPoints
        );
        renderLatencyComparisonChart(document.getElementById('latencyChart'), state.lastResult);
      }
      renderHistoryChart(document.getElementById('historyChart'), state.history);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && speedTestService.isRunning()) {
      speedTestService.cancel();
    }
  });

  document.getElementById('modeSimpleBtn')?.addEventListener('click', () => setUiMode('simple'));
  document.getElementById('modeAdvancedBtn')?.addEventListener('click', () => setUiMode('advanced'));
  document.getElementById('openAdvancedFromSimpleBtn')?.addEventListener('click', () => {
    setUiMode('advanced');
    document.getElementById('diagnosticCard')?.scrollIntoView({ behavior: 'smooth' });
  });

  const contextToggleBtn = document.getElementById('contextToggleBtn');
  const contextDrawer = document.getElementById('contextDrawer');
  contextToggleBtn?.addEventListener('click', () => {
    if (!contextDrawer) return;
    const willOpen = contextDrawer.classList.contains('hidden');
    contextDrawer.classList.toggle('hidden', !willOpen);
    contextToggleBtn.setAttribute('aria-expanded', String(willOpen));
    syncContextIndicator();
  });

  document.getElementById('linkTypeSelect')?.addEventListener('change', syncContextIndicator);
  document.getElementById('contractedInput')?.addEventListener('input', syncContextIndicator);

  document.getElementById('diagDetailsToggle')?.addEventListener('click', () => {
    state.diagDetailsExpanded = !state.diagDetailsExpanded;
    syncDiagnosticDetailsVisibility();
  });

  document.getElementById('startBtnSimple')?.addEventListener('click', triggerStartOrCancel);
  document.getElementById('startBtnAdv')?.addEventListener('click', triggerStartOrCancel);

  document.getElementById('deviceSearchForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = document.getElementById('deviceQueryInput')?.value || '';
    handleDeviceLookup(raw);
  });

  document.getElementById('copyReportBtn')?.addEventListener('click', async () => {
    if (!state.lastResult || !state.lastDiagnosis || !state.lastGaming) return;
    const notes = document.getElementById('techNotesInput')?.value || '';
    const txt = buildTechnicalReportTxt(
      state.lastResult,
      state.lastDiagnosis,
      state.lastGaming,
      notes
    );
    try {
      await navigator.clipboard.writeText(txt);
      showStatusBanner('good', 'Laudo técnico copiado para a área de transferência.');
    } catch {
      downloadFile(`testai-laudo-${state.lastResult.id}.txt`, txt, 'text/plain;charset=utf-8');
    }
  });

  document.getElementById('downloadTxtBtn')?.addEventListener('click', () => {
    if (!state.lastResult || !state.lastDiagnosis || !state.lastGaming) return;
    const notes = document.getElementById('techNotesInput')?.value || '';
    const txt = buildTechnicalReportTxt(
      state.lastResult,
      state.lastDiagnosis,
      state.lastGaming,
      notes
    );
    downloadFile(`testai-laudo-${state.lastResult.id}.txt`, txt, 'text/plain;charset=utf-8');
  });

  document.getElementById('exportJsonBtn')?.addEventListener('click', () => {
    downloadFile(
      `testai-historico-${Date.now()}.json`,
      exportHistoryJson(state.history),
      'application/json;charset=utf-8'
    );
  });

  document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
    downloadFile(
      `testai-historico-${Date.now()}.csv`,
      exportHistoryCsv(state.history),
      'text/csv;charset=utf-8'
    );
  });

  document.getElementById('clearHistoryBtn')?.addEventListener('click', () => {
    state.history = clearHistory();
    state.selectedForCompare = [];
    renderHistoryPanel();
  });
});