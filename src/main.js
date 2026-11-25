/**
 * Orquestrador principal do TestAi.
 * Coordena ciclo de vida do motor, loop de fluidez 60 FPS, alternância de modos
 * e inicialização segura dos módulos de interface em src/ui/.
 */

import { SpeedTestService } from './services/speedtest.service.js';
import { registerServiceWorker, setupInstallPrompt } from './services/pwa.js';
import {
  DEFAULT_RUNTIME_CONFIG,
  getRuntimeConfig,
  getRuntimeState,
  loadRuntimeConfig,
  RUNTIME_ROUTES,
  setRuntimeConfig
} from './services/runtime-config.js';
import { buildShareSummaryText, shareTestResult } from './services/share-card.js';
import { applyEmbedMode, copyTextToClipboard } from './utils/embed-mode.js';
import {
  buildHistoryEntry,
  clearHistory as clearInsightsHistory,
  computeComparisonDelta,
  exportHistoryAsCsv,
  exportHistoryAsJson,
  loadHistoryEntries,
  MAX_HISTORY_ENTRIES
} from './services/history.service.js';
import { evaluateUsageProfiles } from './services/usage-verdict.js';
import {
  renderRecentHistoryPanel,
  renderUsageVerdictsAndComparison,
  resetUsageVerdictsUI
} from './ui/insights-view.js';
import { setupLookingGlassPanel } from './ui/looking-glass-view.js';
import { evaluateConnection } from './diagnostics/connection-diagnostics.js';
import { evaluateGamingReadiness } from './diagnostics/gaming-analyzer.js';
import {
  evaluateSimpleStability,
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
  deleteHistoryRecord,
  exportHistoryCsv,
  exportHistoryJson,
  loadHistory,
  toHistoryRecord
} from './storage/history.storage.js';
import {
  computeMeanMbps,
  computePeakMbps,
  formatCoherentDeltaMs,
  formatDuration,
  formatLatency,
  formatMetricWithUnit,
  formatSpeed,
  getCanonicalSpeedMeta,
  resolvePrimaryAndPeakSpeed,
  setText
} from './utils/formatters.js';
import { isNonNegativeNumber, METRIC_STATUS } from './utils/validators.js';
import { setButtonIconAndLabel } from './ui/icons.js';
import {
  PHASE_LABELS,
  computeSmoothedTarget,
  downloadFile,
  formatContractedPlanReference,
  hideStatusBanner,
  renderTabularSpeedValue,
  resetTelemetryUI,
  resolveGaugeScaleMax,
  setActiveMetricPhase,
  setAllTelemetryEmpty,
  setBootLoadingControls,
  setContainerEmpty,
  setRunningControls,
  setSimpleStatTone,
  setUnitVisible,
  showStatusBanner,
  syncContextIndicator,
  updateLoadedJitterUI,
  updateOnlineIndicator,
  updateProgressBar,
  updateRouteOriginBadge,
  updateSimpleGauge,
  updateSimpleGaugePlanMarker
} from './ui/telemetry-view.js';
import { renderSimpleVerdict } from './ui/simple-view.js';
import {
  createDevicePanelController,
  renderDeviceComparisonPanel
} from './ui/device-panel.js';
import {
  renderDiagnosticsAndGaming,
  renderTechnicalPanel,
  resetDiagnosticsAndTechnicalUI,
  syncDiagnosticDetailsVisibility
} from './ui/diagnostics-view.js';
import { renderHistoryPanel } from './ui/history-view.js';

const state = {
  initialized: false,
  runtimeReady: false,
  /** @type {'on-net' | 'off-net-fallback'} */
  activeRoute: RUNTIME_ROUTES.OFF_NET_FALLBACK,
  uiMode: 'simple',
  lastResult: null,
  lastDiagnosis: null,
  lastGaming: null,
  selectedDevice: null,
  history: [],
  recentHistory: [],
  selectedForCompare: [],
  latestSnapshot: null,
  displayLoopId: null,
  lastFrameTime: 0,
  renderedSpeedMbps: 0,
  targetSpeedMbps: 0,
  activePhase: 'idle',
  hasCompletedTest: false,
  contractedMbps: null,
  diagDetailsExpanded: false,
  backgroundedDuringRun: false,
  deviceLookupSeq: 0
};

const CONTRACTED_PLAN_STORAGE_KEY = 'testai_contracted_mbps';

function parseContractedMbpsValue(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0 || num > 100000) return null;
  return num;
}

function readPersistedContractedMbps() {
  if (typeof localStorage === 'undefined') return null;
  try {
    return parseContractedMbpsValue(localStorage.getItem(CONTRACTED_PLAN_STORAGE_KEY));
  } catch {
    return null;
  }
}

function persistContractedMbps(value) {
  if (typeof localStorage === 'undefined') return;
  try {
    if (isNonNegativeNumber(value) && value > 0) {
      localStorage.setItem(CONTRACTED_PLAN_STORAGE_KEY, String(value));
    } else {
      localStorage.removeItem(CONTRACTED_PLAN_STORAGE_KEY);
    }
  } catch {
    // Armazenamento pode estar indisponível em modo privado/embed
  }
}

function updateSimplePlanReferenceUI(measuredMbps, contractedMbps) {
  const refEl = document.getElementById('simplePlanRef');
  if (!refEl) return;
  const text = formatContractedPlanReference(measuredMbps, contractedMbps);
  if (text) {
    refEl.textContent = text;
    refEl.classList.remove('hidden');
  } else {
    refEl.textContent = '';
    refEl.classList.add('hidden');
  }
}

function syncContractedPlanValue(rawValue, sourceId = '') {
  const parsed = parseContractedMbpsValue(rawValue);
  state.contractedMbps = parsed;
  const formattedVal = parsed !== null ? String(parsed) : '';

  const simpleInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById('simpleContractedInput')
  );
  const advInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById('contractedInput')
  );

  if (simpleInput && sourceId !== 'simpleContractedInput') {
    simpleInput.value = formattedVal;
  }
  if (advInput && sourceId !== 'contractedInput') {
    advInput.value = formattedVal;
  }

  if (sourceId !== 'init') {
    persistContractedMbps(parsed);
  }

  syncContextIndicator();
  updateSimpleGaugePlanMarker(parsed);

  if (state.lastResult) {
    const dlInfo = resolvePrimaryAndPeakSpeed(
      state.lastResult.series.downloadPoints,
      state.lastResult.metrics.download,
      state.lastResult.stats?.download,
      { measurementMode: state.lastResult.measurementMode }
    );
    const dlMeasured =
      dlInfo.status === METRIC_STATUS.MEASURED && isNonNegativeNumber(dlInfo.primary);
    updateSimplePlanReferenceUI(dlMeasured ? dlInfo.primary : null, parsed);
    updateSimpleGauge(
      dlMeasured ? dlInfo.primary : 0,
      state.lastResult.incomplete ? 'warning' : state.lastDiagnosis?.severity || 'good',
      resolveGaugeScaleMax(parsed)
    );
  }
}

const thermometer = new ThermometerComponent();
const deviceService = new DeviceSpecsService();
const devicePanel = createDevicePanelController({ deviceService, state });
let shareFeedbackTimerId = null;
let copySummaryTimerId = null;

function clearShareFeedbackTimer() {
  if (shareFeedbackTimerId !== null) {
    clearTimeout(shareFeedbackTimerId);
    shareFeedbackTimerId = null;
  }
}

function clearCopySummaryTimer() {
  if (copySummaryTimerId !== null) {
    clearTimeout(copySummaryTimerId);
    copySummaryTimerId = null;
  }
}

function setShareButtonVisible(visible) {
  clearShareFeedbackTimer();
  clearCopySummaryTimer();
  const shareBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('shareResultBtn')
  );
  if (shareBtn) {
    shareBtn.classList.toggle('hidden', !visible);
    shareBtn.disabled = !visible;
    setButtonIconAndLabel(shareBtn, 'share', 'Compartilhar Resultado');
  }
  const copyBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('copySummaryBtn')
  );
  if (copyBtn) {
    copyBtn.classList.toggle('hidden', !visible);
    copyBtn.disabled = !visible;
    setButtonIconAndLabel(copyBtn, 'copy', 'Copiar Resumo');
  }
}

/**
 * @param {any} config
 * @param {'on-net' | 'off-net-fallback'} [activeRoute]
 */
function applyRuntimeBranding(config, activeRoute = RUNTIME_ROUTES.OFF_NET_FALLBACK) {
  if (!config || typeof document === 'undefined' || !document) return;

  if (document.body?.dataset) {
    document.body.dataset.runtimeRoute = activeRoute;
  }
  updateRouteOriginBadge(config, activeRoute);

  if (config.ispName && config.ispName !== DEFAULT_RUNTIME_CONFIG.ispName) {
    const ispEl = document.getElementById('ispNamePill');
    if (ispEl) {
      ispEl.textContent = config.ispName;
      ispEl.classList.remove('hidden');
    }
    document.title = `${config.ispName} — Diagnóstico Inteligente de Internet`;
  }

  const serverEl = document.getElementById('serverInfo');
  if (serverEl) {
    if (serverEl.dataset) {
      serverEl.dataset.route = activeRoute;
    }
    if (config.serverLabel && config.serverLabel !== DEFAULT_RUNTIME_CONFIG.serverLabel) {
      serverEl.textContent = config.serverLabel;
      serverEl.classList.remove('adv-only');
    } else {
      serverEl.textContent = config.serverLabel || DEFAULT_RUNTIME_CONFIG.serverLabel;
    }
  }
}

function refreshHistoryView() {
  renderHistoryPanel({
    state,
    onDeleteRecord(id) {
      state.history = deleteHistoryRecord(id);
      state.recentHistory = state.history.slice(0, MAX_HISTORY_ENTRIES);
      state.selectedForCompare = state.selectedForCompare.filter((item) => item !== id);
      refreshHistoryView();
      renderRecentHistoryPanel(state.recentHistory);
    },
    onToggleCompare(id) {
      if (state.selectedForCompare.includes(id)) {
        state.selectedForCompare = state.selectedForCompare.filter((item) => item !== id);
      } else {
        state.selectedForCompare = [...state.selectedForCompare.slice(-1), id];
      }
      refreshHistoryView();
    }
  });
}

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
      renderTabularSpeedValue('simpleCurrentSpeed', formatted);
      updateSimpleGauge(
        state.renderedSpeedMbps,
        state.activePhase === 'upload' ? 'upload' : 'download',
        resolveGaugeScaleMax(state.contractedMbps)
      );
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

const speedTestService = new SpeedTestService({
  onStart({ profile }) {
    state.latestSnapshot = null;
    state.activePhase = 'latency';
    state.backgroundedDuringRun = false;
    resetTelemetryUI(profile.label, thermometer);
    resetDiagnosticsAndTechnicalUI();
    setRunningControls(true, { hasCompleted: state.hasCompletedTest });
    setShareButtonVisible(false);
    resetUsageVerdictsUI();
    hideStatusBanner();
    startDisplayLoop();
  },

  onProgress(payload) {
    state.latestSnapshot = payload;
    applyLiveTelemetryUpdate(payload);
  },

  onFinish(result) {
    stopDisplayLoop();
    setActiveMetricPhase(null);
    state.hasCompletedTest = true;
    setRunningControls(false, { hasCompleted: true });
    handleCompletedResult(result);
    if (state.backgroundedDuringRun) {
      showStatusBanner(
        'warning',
        'A aba ficou em segundo plano durante o teste; navegadores reduzem timers em background e isso pode alterar a precisão. Repita mantendo esta aba visível.'
      );
    }
  },

  onCancel() {
    stopDisplayLoop();
    setActiveMetricPhase(null);
    setRunningControls(false, { hasCompleted: state.hasCompletedTest });
    setShareButtonVisible(false);
    resetUsageVerdictsUI();
    setAllTelemetryEmpty(false);
    updateSimpleGauge(0, 'idle', resolveGaugeScaleMax(state.contractedMbps));
    state.activePhase = 'cancelled';
    setText('phaseLabel', PHASE_LABELS.cancelled);
    setText('simplePhaseLabel', PHASE_LABELS.cancelled);
    setText(
      'simpleLiveHint',
      state.hasCompletedTest
        ? 'Medição cancelada. Clique em Testar novamente quando quiser recomeçar.'
        : 'Medição cancelada. Clique em Iniciar Teste quando quiser recomeçar.'
    );
    document.getElementById('simpleLiveHint')?.classList.remove('hidden');
    updateProgressBar(0, 'Teste cancelado pelo usuário.');
    showStatusBanner('warning', 'Execução interrompida manualmente.');
  },

  onError(errorPayload) {
    const failedPhase = state.activePhase;
    stopDisplayLoop();
    setActiveMetricPhase(null);
    if (errorPayload.partialResult) {
      state.hasCompletedTest = true;
    }
    setRunningControls(false, { hasCompleted: state.hasCompletedTest });
    state.activePhase = 'error';
    setText('phaseLabel', PHASE_LABELS.error);
    setText('simplePhaseLabel', PHASE_LABELS.error);
    updateProgressBar(0, 'Execução interrompida por falha.');

    const bannerMessage =
      failedPhase === 'upload' && errorPayload.code === 'TIMEOUT'
        ? 'O envio (upload) deste dispositivo/rede local para a internet atingiu o tempo limite sem novas amostras. Verifique sinal Wi-Fi, VPN/extensões ou tente no cabo antes de concluir falha no provedor.'
        : errorPayload.message;
    showStatusBanner('danger', bannerMessage);

    if (errorPayload.partialResult) {
      handleCompletedResult(errorPayload.partialResult, true);
    } else {
      setShareButtonVisible(false);
      resetUsageVerdictsUI();
      setAllTelemetryEmpty(false);
      updateSimpleGauge(0, 'danger', resolveGaugeScaleMax(state.contractedMbps));
    }
  }
});

function applyLiveTelemetryUpdate(payload) {
  const { phase, progressPercent, snapshot } = payload;
  setActiveMetricPhase(phase);

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
  const peakDownloadMbps = computePeakMbps(snapshot.series.downloadPoints);
  const peakUploadMbps = computePeakMbps(snapshot.series.uploadPoints);

  if (phase === 'download') {
    setText('liveMetricTitle', 'DOWNLOAD EM TEMPO REAL');
    setText('simpleHeroEyebrow', 'DOWNLOAD EM TEMPO REAL');
    const target = computeSmoothedTarget(snapshot.series.downloadPoints);
    if (isNonNegativeNumber(target)) {
      state.targetSpeedMbps = target;
      setText('simpleLiveHint', getLiveCapabilityMilestone(target, 'download'));
    }
    if (isNonNegativeNumber(avgDownloadMbps)) {
      setContainerEmpty('simpleDownloadVal', false);
      setText('simpleDownloadVal', `${avgDownloadMbps.toFixed(1)} Mbps`);
    }
    if (isNonNegativeNumber(peakDownloadMbps)) {
      setContainerEmpty('avgSpeed', false);
      setText('avgSpeed', peakDownloadMbps.toFixed(1));
      setText('simpleDownloadAvg', `Pico: ${peakDownloadMbps.toFixed(1)} Mbps`);
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
      const avgUpStr = avgUploadMbps.toFixed(1);
      setContainerEmpty('uploadValue', false);
      setContainerEmpty('simpleUploadVal', false);
      setText('uploadValue', avgUpStr);
      setText('simpleUploadVal', `${avgUpStr} Mbps`);
    }
    if (isNonNegativeNumber(peakUploadMbps)) {
      setContainerEmpty('avgSpeed', false);
      setText('avgSpeed', peakUploadMbps.toFixed(1));
      setText('simpleUploadAvg', `Pico: ${peakUploadMbps.toFixed(1)} Mbps`);
      setText('uploadPeakMeta', `Mbps · Pico ${peakUploadMbps.toFixed(1)}`);
    }
  } else {
    setText('liveMetricTitle', 'SONDAGEM DE LATÊNCIA');
    setText('simpleHeroEyebrow', 'SONDAGEM DE LATÊNCIA');
    setText('simpleLiveHint', getLiveCapabilityMilestone(0, 'latency'));
  }

  setText(
    'avgBreakdown',
    `↓ ${isNonNegativeNumber(peakDownloadMbps) ? peakDownloadMbps.toFixed(1) : '—'} · ↑ ${isNonNegativeNumber(peakUploadMbps) ? peakUploadMbps.toFixed(1) : '—'} Mbps`
  );

  const m = snapshot.metrics;
  if (!isNonNegativeNumber(avgDownloadMbps) && m.download.status === METRIC_STATUS.MEASURED) {
    setContainerEmpty('simpleDownloadVal', false);
    setText('simpleDownloadVal', `${formatSpeed(m.download.value)} Mbps`);
  }
  if (!isNonNegativeNumber(avgUploadMbps) && m.upload.status === METRIC_STATUS.MEASURED) {
    const upFormatted = formatSpeed(m.upload.value);
    setContainerEmpty('uploadValue', false);
    setContainerEmpty('simpleUploadVal', false);
    setText('uploadValue', upFormatted);
    setText('simpleUploadVal', `${upFormatted} Mbps`);
  }
  if (m.ping.status === METRIC_STATUS.MEASURED) {
    const pingFormatted = formatLatency(m.ping.value);
    setContainerEmpty('pingValue', false);
    setContainerEmpty('simplePingVal', false);
    setText('pingValue', pingFormatted);
    setText('simplePingVal', `${pingFormatted} ms`);
  }
  if (m.jitter.status === METRIC_STATUS.MEASURED) {
    setContainerEmpty('jitterValue', false);
    setText('jitterValue', formatLatency(m.jitter.value, 1));
  }
  if (m.downloadLatency.status === METRIC_STATUS.MEASURED) {
    setContainerEmpty('downloadLatencyValue', false);
    setText('downloadLatencyValue', formatLatency(m.downloadLatency.value));
  }
  if (m.uploadLatency.status === METRIC_STATUS.MEASURED) {
    setContainerEmpty('uploadLatencyValue', false);
    setText('uploadLatencyValue', formatLatency(m.uploadLatency.value));
  }
  updateLoadedJitterUI(m.downloadJitter, m.uploadJitter, true);

  const hasThroughputPts =
    snapshot.series.downloadPoints.length > 0 || snapshot.series.uploadPoints.length > 0;
  setContainerEmpty('throughputChart', !hasThroughputPts);

  renderThroughputChart(
    document.getElementById('throughputChart'),
    snapshot.series.downloadPoints,
    snapshot.series.uploadPoints
  );
}

function handleCompletedResult(result, isPartial = false) {
  setAllTelemetryEmpty(false);

  const diagnosis = evaluateConnection(result);
  const gaming = evaluateGamingReadiness(result);

  state.lastResult = result;
  state.lastDiagnosis = diagnosis;
  state.lastGaming = gaming;
  state.activePhase = isPartial ? 'error' : 'completed';

  const m = result.metrics;
  const isCommercial = result.measurementMode === 'commercial';
  const speedMeta = getCanonicalSpeedMeta(result.measurementMode);
  const dlInfo = resolvePrimaryAndPeakSpeed(
    result.series.downloadPoints,
    m.download,
    result.stats?.download,
    { measurementMode: result.measurementMode }
  );
  const ulInfo = resolvePrimaryAndPeakSpeed(
    result.series.uploadPoints,
    m.upload,
    result.stats?.upload,
    { measurementMode: result.measurementMode }
  );

  const dlMeasured =
    dlInfo.status === METRIC_STATUS.MEASURED && isNonNegativeNumber(dlInfo.primary);
  const dlFinal = formatSpeed(dlInfo.primary, 1, dlInfo.status);
  const ulFinal = formatSpeed(ulInfo.primary, 1, ulInfo.status);
  const pingFinal = formatLatency(m.ping.value, 0, m.ping.status);

  // Atualiza Modo Simples (estatística canônica idêntica para Download e Upload)
  setText('simpleHeroEyebrow', isCommercial ? 'Download (P90)' : 'Download (P50)');
  setText('simplePhaseLabel', isPartial ? 'Teste parcial' : PHASE_LABELS.completed);
  renderTabularSpeedValue('simpleCurrentSpeed', dlFinal);
  setUnitVisible('simpleSpeedUnit', dlMeasured);
  setText('simpleDownloadVal', formatMetricWithUnit(dlInfo.primary, 'Mbps', 1, dlInfo.status));
  setText('simpleUploadVal', formatMetricWithUnit(ulInfo.primary, 'Mbps', 1, ulInfo.status));
  setText('simplePingVal', formatMetricWithUnit(m.ping.value, 'ms', 0, m.ping.status));
  setText(
    'simpleDownloadAvg',
    isNonNegativeNumber(dlInfo.peak) ? `Pico: ${dlInfo.peak.toFixed(1)} Mbps` : 'Pico: —'
  );
  setText(
    'simpleUploadAvg',
    isNonNegativeNumber(ulInfo.peak) ? `Pico: ${ulInfo.peak.toFixed(1)} Mbps` : 'Pico: —'
  );

  setSimpleStatTone(
    'simpleDownloadVal',
    m.download.status === METRIC_STATUS.FAILED ? 'danger' : 'neutral'
  );
  setSimpleStatTone(
    'simpleUploadVal',
    m.upload.status === METRIC_STATUS.FAILED ? 'danger' : 'neutral'
  );
  setSimpleStatTone(
    'simplePingVal',
    m.ping.status === METRIC_STATUS.FAILED ? 'danger' : 'neutral'
  );

  const stability = evaluateSimpleStability(result, isPartial);
  setText('simpleStabilityVal', stability.label);
  setText('simpleStabilitySub', stability.sub);
  setSimpleStatTone('simpleStabilityVal', stability.tone);

  const activePlanMbps = state.contractedMbps ?? result.context?.contractedMbps ?? null;
  updateSimpleGauge(
    dlMeasured ? dlInfo.primary : 0,
    isPartial ? 'warning' : diagnosis.severity,
    resolveGaugeScaleMax(activePlanMbps)
  );
  updateSimplePlanReferenceUI(dlMeasured ? dlInfo.primary : null, activePlanMbps);

  const uploadUnavailable = isPartial && m.upload.status !== METRIC_STATUS.MEASURED;
  setText(
    'simpleLiveHint',
    uploadUnavailable
      ? 'Medição parcial: o envio deste dispositivo/rede local para a internet não concluiu. Confira os detalhes abaixo.'
      : isPartial
        ? 'Medição parcial concluída. Confira o resumo abaixo.'
        : 'Medição concluída com sucesso.'
  );
  document.getElementById('simpleLiveHint')?.classList.add('hidden');

  renderSimpleVerdict(diagnosis);

  // Atualiza Modo Avançado (estatística canônica idêntica no destaque, com Pico/P50 secundários)
  setText('phaseLabel', isPartial ? 'Parcial' : 'Concluído');
  setText('liveMetricTitle', speedMeta.downloadTitle);
  setText('uploadMetricLabel', speedMeta.uploadTitle);
  setText('currentSpeed', dlFinal);
  setUnitVisible('advSpeedUnit', dlMeasured);
  setText('uploadValue', ulFinal);
  let uploadMetaText = 'Mbps';
  if (isCommercial && isNonNegativeNumber(result.stats?.upload?.p50)) {
    uploadMetaText = isNonNegativeNumber(ulInfo.peak)
      ? `Mbps · P50 ${result.stats.upload.p50.toFixed(1)} · Pico ${ulInfo.peak.toFixed(1)}`
      : `Mbps · P50 ${result.stats.upload.p50.toFixed(1)}`;
  } else if (isNonNegativeNumber(ulInfo.peak)) {
    uploadMetaText = `Mbps · Pico ${ulInfo.peak.toFixed(1)}`;
  }
  setText('uploadPeakMeta', uploadMetaText);
  setText('pingValue', pingFinal);
  setText('jitterValue', formatLatency(m.jitter.value, 1, m.jitter.status));
  setText('downloadLatencyValue', formatLatency(m.downloadLatency.value, 0, m.downloadLatency.status));
  setText('uploadLatencyValue', formatLatency(m.uploadLatency.value, 0, m.uploadLatency.status));
  updateLoadedJitterUI(m.downloadJitter, m.uploadJitter, false);

  const dlDeltaCoherentText = formatCoherentDeltaMs(
    m.ping.value,
    m.downloadLatency.value,
    m.downloadLatencyDelta.value
  );
  const ulDeltaCoherentText = formatCoherentDeltaMs(
    m.ping.value,
    m.uploadLatency.value,
    m.uploadLatencyDelta.value
  );

  setText('downloadLatencyDeltaMeta', `ms (${dlDeltaCoherentText})`);
  setText('uploadLatencyDeltaMeta', `ms (${ulDeltaCoherentText})`);

  setText(
    'avgSpeed',
    formatSpeed(
      dlInfo.peak,
      1,
      isNonNegativeNumber(dlInfo.peak) ? METRIC_STATUS.MEASURED : METRIC_STATUS.UNAVAILABLE
    )
  );
  setText(
    'avgBreakdown',
    `↓ ${formatSpeed(dlInfo.peak, 1, isNonNegativeNumber(dlInfo.peak) ? METRIC_STATUS.MEASURED : METRIC_STATUS.UNAVAILABLE)} · ↑ ${formatSpeed(ulInfo.peak, 1, isNonNegativeNumber(ulInfo.peak) ? METRIC_STATUS.MEASURED : METRIC_STATUS.UNAVAILABLE)} Mbps`
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
    `Ocioso ${formatLatency(m.ping.value)} ms · ↓ ${dlDeltaCoherentText} · ↑ ${ulDeltaCoherentText}`
  );
  renderLatencyComparisonChart(document.getElementById('latencyChart'), result);

  if (result.routeType === 'on-net' || result.routeType === 'off-net-fallback') {
    state.activeRoute = result.routeType;
    applyRuntimeBranding(getRuntimeConfig(), result.routeType);
  }

  renderDiagnosticsAndGaming(diagnosis, gaming, state);
  renderTechnicalPanel(result);

  if (state.selectedDevice) {
    renderDeviceComparisonPanel(state.selectedDevice, state.lastResult);
  }

  const previousEntry = state.history[0] || state.recentHistory[0] || null;
  const record = toHistoryRecord(result, diagnosis, gaming, getRuntimeConfig());
  state.history = appendHistoryRecord(record);
  state.recentHistory = state.history.slice(0, MAX_HISTORY_ENTRIES);
  refreshHistoryView();

  const currentEntry = state.recentHistory[0] || buildHistoryEntry(result, getRuntimeConfig());
  const comparisonDelta = computeComparisonDelta(currentEntry, previousEntry);
  const usageVerdicts = evaluateUsageProfiles(result);
  renderUsageVerdictsAndComparison(usageVerdicts, comparisonDelta);
  renderRecentHistoryPanel(state.recentHistory);

  setShareButtonVisible(true);
}

function triggerStartOrCancel() {
  if (speedTestService.isRunning()) {
    speedTestService.cancel();
    return;
  }
  if (!state.runtimeReady) {
    return;
  }

  const profileEl = /** @type {HTMLSelectElement | null} */ (
    document.getElementById('profileSelect')
  );
  const linkEl = /** @type {HTMLSelectElement | null} */ (
    document.getElementById('linkTypeSelect')
  );
  const contractedEl = /** @type {HTMLInputElement | null} */ (
    document.getElementById('contractedInput')
  );
  const simpleContractedEl = /** @type {HTMLInputElement | null} */ (
    document.getElementById('simpleContractedInput')
  );
  const notesEl = /** @type {HTMLInputElement | null} */ (
    document.getElementById('techNotesInput')
  );

  const profileId = profileEl?.value || 'standard';
  const linkType = linkEl?.value || 'nao-informado';
  const contractedMbps =
    state.contractedMbps ??
    parseContractedMbpsValue(contractedEl?.value) ??
    parseContractedMbpsValue(simpleContractedEl?.value);
  const notes = notesEl?.value || '';

  speedTestService.start(profileId, {
    linkType,
    contractedMbps,
    notes
  });
}

function setupTabs() {
  const tabButtons = /** @type {NodeListOf<HTMLElement>} */ (
    document.querySelectorAll('.tab-btn')
  );
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

function initApp() {
  if (state.initialized) return;
  state.initialized = true;

  // Registra controles críticos primeiro para nenhum erro de painel impedir o clique
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

  const syncPageHiddenState = () => {
    document.body?.classList?.toggle('is-page-hidden', Boolean(document.hidden));
  };
  syncPageHiddenState();

  document.addEventListener('visibilitychange', () => {
    syncPageHiddenState();
    if (!speedTestService.isRunning()) return;
    if (document.hidden) {
      state.backgroundedDuringRun = true;
    } else if (state.backgroundedDuringRun) {
      showStatusBanner(
        'warning',
        'Esta aba ficou em segundo plano durante a medição. Mantenha-a visível para evitar desaceleração de timers do navegador.'
      );
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
  document.getElementById('contractedInput')?.addEventListener('input', (e) => {
    const target = /** @type {HTMLInputElement | null} */ (e.target);
    syncContractedPlanValue(target?.value ?? '', 'contractedInput');
  });
  document.getElementById('simpleContractedInput')?.addEventListener('input', (e) => {
    const target = /** @type {HTMLInputElement | null} */ (e.target);
    syncContractedPlanValue(target?.value ?? '', 'simpleContractedInput');
  });

  document.getElementById('diagDetailsToggle')?.addEventListener('click', () => {
    state.diagDetailsExpanded = !state.diagDetailsExpanded;
    syncDiagnosticDetailsVisibility(state.diagDetailsExpanded);
  });

  document.getElementById('startBtnSimple')?.addEventListener('click', triggerStartOrCancel);
  document.getElementById('startBtnAdv')?.addEventListener('click', triggerStartOrCancel);

  const shareBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('shareResultBtn')
  );
  shareBtn?.addEventListener('click', async () => {
    if (!state.lastResult || shareBtn.disabled) return;
    clearShareFeedbackTimer();
    shareBtn.disabled = true;
    setButtonIconAndLabel(shareBtn, 'share', 'Gerando card...');

    let status = 'error';
    try {
      const outcome = await shareTestResult(state.lastResult, getRuntimeConfig());
      status = outcome.status;
      if (status === 'shared') {
        setButtonIconAndLabel(shareBtn, 'check', 'Compartilhado!');
      } else if (status === 'downloaded') {
        setButtonIconAndLabel(shareBtn, 'check', 'Card salvo!');
      } else {
        setButtonIconAndLabel(shareBtn, 'share', 'Compartilhar Resultado');
      }
    } catch {
      setButtonIconAndLabel(shareBtn, 'share', 'Erro ao gerar card');
    }

    if (status === 'cancelled') {
      shareBtn.disabled = speedTestService.isRunning();
      return;
    }

    shareFeedbackTimerId = setTimeout(() => {
      shareFeedbackTimerId = null;
      if (speedTestService.isRunning()) return;
      setButtonIconAndLabel(shareBtn, 'share', 'Compartilhar Resultado');
      shareBtn.disabled = false;
    }, 2200);
  });

  const copySummaryBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('copySummaryBtn')
  );
  copySummaryBtn?.addEventListener('click', async () => {
    if (!state.lastResult || copySummaryBtn.disabled) return;
    clearCopySummaryTimer();
    copySummaryBtn.disabled = true;

    const summaryText = buildShareSummaryText(state.lastResult, getRuntimeConfig());
    const copied = await copyTextToClipboard(summaryText);
    setButtonIconAndLabel(
      copySummaryBtn,
      copied ? 'check' : 'copy',
      copied ? 'Resumo copiado!' : 'Erro ao copiar'
    );

    copySummaryTimerId = setTimeout(() => {
      copySummaryTimerId = null;
      if (speedTestService.isRunning()) return;
      setButtonIconAndLabel(copySummaryBtn, 'copy', 'Copiar Resumo');
      copySummaryBtn.disabled = false;
    }, 2000);
  });

  document.getElementById('deviceSearchForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const queryEl = /** @type {HTMLInputElement | null} */ (
      document.getElementById('deviceQueryInput')
    );
    const raw = queryEl?.value || '';
    devicePanel.handleDeviceLookup(raw);
  });

  document.getElementById('copyReportBtn')?.addEventListener('click', async () => {
    if (!state.lastResult || !state.lastDiagnosis || !state.lastGaming) return;
    const notesEl = /** @type {HTMLInputElement | null} */ (
      document.getElementById('techNotesInput')
    );
    const notes = notesEl?.value || '';
    const txt = buildTechnicalReportTxt(
      state.lastResult,
      state.lastDiagnosis,
      state.lastGaming,
      notes,
      getRuntimeConfig()
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
    const notesEl = /** @type {HTMLInputElement | null} */ (
      document.getElementById('techNotesInput')
    );
    const notes = notesEl?.value || '';
    const txt = buildTechnicalReportTxt(
      state.lastResult,
      state.lastDiagnosis,
      state.lastGaming,
      notes,
      getRuntimeConfig()
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
    state.recentHistory = [];
    state.selectedForCompare = [];
    refreshHistoryView();
    renderRecentHistoryPanel(state.recentHistory);
    resetUsageVerdictsUI();
  });

  document.getElementById('recentExportCsvBtn')?.addEventListener('click', () => {
    if (!state.recentHistory.length) return;
    downloadFile(
      `testai-historico-${Date.now()}.csv`,
      exportHistoryAsCsv(state.recentHistory),
      'text/csv;charset=utf-8'
    );
  });

  document.getElementById('recentExportJsonBtn')?.addEventListener('click', () => {
    if (!state.recentHistory.length) return;
    downloadFile(
      `testai-historico-${Date.now()}.json`,
      exportHistoryAsJson(state.recentHistory),
      'application/json;charset=utf-8'
    );
  });

  document.getElementById('recentClearHistoryBtn')?.addEventListener('click', () => {
    state.recentHistory = clearInsightsHistory();
    state.history = [];
    state.selectedForCompare = [];
    refreshHistoryView();
    renderRecentHistoryPanel(state.recentHistory);
    resetUsageVerdictsUI();
  });

  applyEmbedMode();
  setUiMode('simple');
  setupTabs();
  updateOnlineIndicator();
  syncContractedPlanValue(readPersistedContractedMbps(), 'init');
  devicePanel.renderBrandCards();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let installHintTimerId = null;
  setupInstallPrompt({
    onFallback: (message) => {
      let toast = document.getElementById('pwaInstallToast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'pwaInstallToast';
        toast.className = 'pwa-install-toast';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        toast.addEventListener('click', () => {
          toast?.classList.add('hidden');
        });
        document.body.appendChild(toast);
      }
      toast.textContent = message;
      toast.classList.remove('hidden');
      if (installHintTimerId) clearTimeout(installHintTimerId);
      installHintTimerId = setTimeout(() => {
        installHintTimerId = null;
        toast?.classList.add('hidden');
      }, 6500);
    },
  });
  registerServiceWorker();
  const lookingGlassPanel = setupLookingGlassPanel({ getConfig: getRuntimeConfig });

  state.runtimeReady = false;
  setBootLoadingControls(true);
  updateRouteOriginBadge(getRuntimeConfig(), state.activeRoute);

  loadRuntimeConfig()
    .then((config) => {
      const rtState = getRuntimeState();
      state.activeRoute = rtState.activeRoute;
      speedTestService.setRuntimeConfig(config);
      applyRuntimeBranding(config, rtState.activeRoute);
    })
    .catch(() => {
      const fallback = setRuntimeConfig(null, { usedFallback: true });
      state.activeRoute = RUNTIME_ROUTES.OFF_NET_FALLBACK;
      speedTestService.setRuntimeConfig(fallback);
      applyRuntimeBranding(fallback, RUNTIME_ROUTES.OFF_NET_FALLBACK);
    })
    .finally(() => {
      state.runtimeReady = true;
      if (!speedTestService.isRunning()) {
        setBootLoadingControls(false);
      }
      lookingGlassPanel.refreshAvailability().catch(() => {});
    });

  try {
    state.history = loadHistory();
    state.recentHistory = loadHistoryEntries();
    refreshHistoryView();
    renderRecentHistoryPanel(state.recentHistory);
  } catch (err) {
    console.error('[TestAi] Falha ao carregar histórico local unificado:', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp, { once: true });
} else {
  initApp();
}
