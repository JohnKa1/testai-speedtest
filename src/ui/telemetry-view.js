/**
 * Módulo de visualização de telemetria ao vivo, progresso, banners e controles.
 */

import { computeGaugePercent, setText } from '../utils/formatters.js';
import { isNonNegativeNumber, METRIC_STATUS } from '../utils/validators.js';
import {
  renderLatencyComparisonChart,
  renderThroughputChart
} from '../components/charts.js';

export const PHASE_LABELS = Object.freeze({
  idle: 'Aguardando',
  latency: 'Medindo Ping',
  download: 'Testando Download',
  upload: 'Testando Upload',
  completed: 'Concluído',
  cancelled: 'Cancelado',
  error: 'Falha'
});

export function computeSmoothedTarget(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const recent = points.slice(-3);
  const weights = [0.2, 0.3, 0.5].slice(-recent.length);
  const weightSum = weights.reduce((acc, w) => acc + w, 0);
  return recent.reduce((acc, pt, idx) => acc + pt.mbps * (weights[idx] / weightSum), 0);
}

export function setContainerEmpty(childId, isEmpty) {
  const child = document.getElementById(childId);
  const box = child?.closest('.simple-stat, .metric-card, .avg-box, .canvas-wrap');
  if (box) {
    box.classList.toggle('is-empty', Boolean(isEmpty));
  }
}

export function setAllTelemetryEmpty(isEmpty) {
  [
    'simpleDownloadVal',
    'simpleUploadVal',
    'simplePingVal',
    'simpleStabilityVal',
    'avgSpeed',
    'uploadValue',
    'pingValue',
    'jitterValue',
    'downloadLatencyValue',
    'uploadLatencyValue',
    'loadedJitterValue',
    'throughputChart',
    'latencyChart'
  ].forEach((id) => setContainerEmpty(id, isEmpty));
}

export function updateSimpleGauge(mbps, tone = 'idle') {
  const stage = document.getElementById('simpleSpeedStage');
  if (!stage) return;
  stage.style.setProperty('--pct', String(computeGaugePercent(mbps)));
  stage.dataset.gaugeTone = tone || 'idle';
}

export function setUnitVisible(id, visible) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.toggle('hidden', !visible);
  }
}

export function setSimpleStatTone(id, tone) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('tone-good', 'tone-warning', 'tone-danger', 'tone-info');
  if (tone === 'warning' || tone === 'danger') {
    el.classList.add(`tone-${tone}`);
  }
}

/**
 * @param {import('../types.js').MetricEntry} dlJitterMetric
 * @param {import('../types.js').MetricEntry} ulJitterMetric
 * @param {boolean} [showEmptyWhenMissing]
 */
export function updateLoadedJitterUI(dlJitterMetric, ulJitterMetric, showEmptyWhenMissing = true) {
  const hasDl = dlJitterMetric?.status === METRIC_STATUS.MEASURED;
  const hasUl = ulJitterMetric?.status === METRIC_STATUS.MEASURED;

  if (!hasDl && !hasUl) {
    setText('loadedJitterValue', '—');
    setText('loadedJitterBreakdownMeta', '↓ — · ↑ — ms');
    if (showEmptyWhenMissing) {
      setContainerEmpty('loadedJitterValue', true);
    }
    return;
  }

  setContainerEmpty('loadedJitterValue', false);
  const maxVal = Math.max(hasDl ? dlJitterMetric.value : 0, hasUl ? ulJitterMetric.value : 0);
  setText('loadedJitterValue', `${maxVal.toFixed(1)} ms`);
  setText(
    'loadedJitterBreakdownMeta',
    `↓ ${hasDl ? dlJitterMetric.value.toFixed(1) : '—'} · ↑ ${hasUl ? ulJitterMetric.value.toFixed(1) : '—'} ms`
  );
}

/** @type {Record<string, { accent: string | null, selectors: string[] }>} */
const PHASE_FOCUS_MAP = Object.freeze({
  latency: {
    accent: null,
    selectors: ['#simplePingVal', '#pingValue'],
  },
  download: {
    accent: 'download',
    selectors: ['#simpleDownloadVal', '#downloadLatencyValue'],
  },
  upload: {
    accent: 'upload',
    selectors: ['#simpleUploadVal', '#uploadValue'],
  },
});

/**
 * Destaca sutilmente o indicador correspondente à etapa ativa do teste
 * ("Staging the focus"), mantendo os demais cards em estado neutro.
 *
 * @param {string | null | undefined} phase
 */
export function setActiveMetricPhase(phase) {
  if (typeof document === 'undefined') return;
  document
    .querySelectorAll('.simple-stat.is-active-phase, .metric-card.is-active-phase')
    .forEach((el) => {
      el.classList.remove('is-active-phase');
      el.removeAttribute('data-phase-accent');
    });

  const spec =
    phase && Object.prototype.hasOwnProperty.call(PHASE_FOCUS_MAP, phase)
      ? PHASE_FOCUS_MAP[phase]
      : null;
  if (!spec) return;

  for (const selector of spec.selectors) {
    const valueEl = document.querySelector(selector);
    const cardEl = valueEl?.closest('.simple-stat, .metric-card');
    if (!cardEl) continue;
    cardEl.classList.add('is-active-phase');
    if (spec.accent) {
      cardEl.setAttribute('data-phase-accent', spec.accent);
    }
  }
}

export function resetTelemetryUI(profileLabel, thermometer) {
  setAllTelemetryEmpty(true);
  updateSimpleGauge(0, 'idle');
  setUnitVisible('simpleSpeedUnit', true);
  setUnitVisible('advSpeedUnit', true);

  ['simpleDownloadVal', 'simpleUploadVal', 'simplePingVal', 'simpleStabilityVal'].forEach(
    (id) => setSimpleStatTone(id, 'neutral')
  );

  // Modo Simples
  setText('simpleHeroEyebrow', 'INICIANDO TESTE');
  setText('simplePhaseLabel', 'Preparando');
  setText('simpleCurrentSpeed', '0.0');
  setText('simpleDownloadVal', '—');
  setText('simpleUploadVal', '—');
  setText('simplePingVal', '—');
  setText('simpleStabilityVal', '—');
  setText('simpleStabilitySub', 'Sob uso intenso');
  setText('simpleDownloadAvg', 'Pico: —');
  setText('simpleUploadAvg', 'Pico: —');
  setText('simpleLiveHint', 'Iniciando sondagem com a borda mais próxima...');
  document.getElementById('simpleLiveHint')?.classList.remove('hidden');
  document.getElementById('simpleVerdictCard')?.classList.add('hidden');

  // Modo Avançado
  setText('currentSpeed', '0.0');
  setText('liveMetricTitle', 'VAZÃO ATUAL');
  setText('phaseLabel', 'Iniciando');
  setText('avgSpeed', '—');
  setText('avgBreakdown', '↓ — · ↑ — Mbps');
  setText('uploadPeakMeta', 'Mbps');

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

  thermometer?.reset();
  setActiveMetricPhase('latency');
  updateProgressBar(4, `Inicializando perfil ${profileLabel}...`);

  renderThroughputChart(document.getElementById('throughputChart'), [], []);
  renderLatencyComparisonChart(document.getElementById('latencyChart'), null);
}

export function setRunningControls(isRunning) {
  const btnAdv = document.getElementById('startBtnAdv');
  const btnSimple = document.getElementById('startBtnSimple');
  const profileSel = /** @type {HTMLSelectElement | null} */ (
    document.getElementById('profileSelect')
  );
  const panel = document.getElementById('telemetryPanel');
  const phaseBadge = document.getElementById('phaseLabel');
  const simplePhaseBadge = document.getElementById('simplePhaseLabel');
  const thermoFill = document.getElementById('thermoFill');
  const progressSection = document.getElementById('progressSection');

  if (progressSection) progressSection.classList.toggle('is-running', isRunning);
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

export function updateProgressBar(percent, label) {
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

export function showStatusBanner(severity, message) {
  const banner = document.getElementById('statusBanner');
  if (!banner) return;
  banner.className = `status-banner severity-${severity}`;
  banner.textContent = message;
  banner.classList.remove('hidden');
}

export function hideStatusBanner() {
  const banner = document.getElementById('statusBanner');
  if (banner) banner.classList.add('hidden');
}

export function updateOnlineIndicator() {
  const online = typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
    ? navigator.onLine
    : true;
  const dot = document.getElementById('networkDot');
  if (dot) {
    dot.classList.toggle('online', online);
    dot.classList.toggle('offline', !online);
  }
  setText('networkStatusText', online ? 'Online' : 'Offline');
}

export function syncContextIndicator() {
  const toggleBtn = document.getElementById('contextToggleBtn');
  const drawer = document.getElementById('contextDrawer');
  const linkEl = /** @type {HTMLSelectElement | null} */ (document.getElementById('linkTypeSelect'));
  const contractedEl = /** @type {HTMLInputElement | null} */ (
    document.getElementById('contractedInput')
  );
  const linkVal = linkEl?.value || 'nao-informado';
  const contractedVal = Number(contractedEl?.value);

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

export function downloadFile(filename, content, mimeType) {
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
