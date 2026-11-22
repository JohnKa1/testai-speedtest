/**
 * Módulo de renderização das abas Diagnóstico & Gaming e Telemetria Técnica (Modo Avançado).
 */

import {
  clearElement,
  createEl,
  formatBytes,
  formatDateTime,
  formatDeltaMs,
  formatDuration,
  formatMetricWithUnit,
  resolvePrimaryAndPeakSpeed,
  setText
} from '../utils/formatters.js';
import { METRIC_STATUS } from '../utils/validators.js';

export function resetDiagnosticsAndTechnicalUI() {
  document.getElementById('diagnosticEmpty')?.classList.remove('hidden');
  document.getElementById('diagnosticStack')?.classList.add('hidden');

  setText('techSessionId', 'Sessão: —');

  const tbody = document.getElementById('techMetricsBody');
  if (tbody) {
    clearElement(tbody);
    const tr = document.createElement('tr');
    const td = createEl('td', 'muted-cell', 'Nenhuma telemetria coletada ainda.');
    td.colSpan = 5;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  const ctxGrid = document.getElementById('techContextGrid');
  if (ctxGrid) {
    clearElement(ctxGrid);
  }
}

export function syncDiagnosticDetailsVisibility(expanded) {
  const gridEl = document.getElementById('diagStructuredGrid');
  const toggleBtn = document.getElementById('diagDetailsToggle');
  if (!gridEl || !toggleBtn) return;

  gridEl.classList.toggle('hidden', !expanded);
  toggleBtn.setAttribute('aria-expanded', String(expanded));
  toggleBtn.textContent = expanded
    ? 'Ocultar detalhamento técnico'
    : 'Ver detalhamento técnico completo';
}

/**
 * @param {import('../types.js').DiagnosisResult} diagnosis
 * @param {import('../types.js').GamingResult} gaming
 * @param {Record<string, any>} [state]
 */
export function renderDiagnosticsAndGaming(diagnosis, gaming, state) {
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
  if (state) {
    state.diagDetailsExpanded = !isHealthy;
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle('hidden', !isHealthy);
  }
  syncDiagnosticDetailsVisibility(!isHealthy);

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
    box.appendChild(createEl('div', `gaming-genre-fit tone-${g.tone || 'neutral'}`, g.fit));
    box.appendChild(createEl('p', 'gaming-genre-note', g.note));
    genresEl.appendChild(box);
  });
}

/**
 * @param {import('../types.js').SpeedTestResult} result
 */
export function renderTechnicalPanel(result) {
  const tbody = document.getElementById('techMetricsBody');
  const ctxGrid = document.getElementById('techContextGrid');
  if (!tbody || !ctxGrid) return;

  setText('techSessionId', `Sessão: ${result.id}`);
  clearElement(tbody);

  const m = result.metrics;
  const s = result.stats;
  const dlInfo = resolvePrimaryAndPeakSpeed(result.series?.downloadPoints, m.download, s.download);
  const ulInfo = resolvePrimaryAndPeakSpeed(result.series?.uploadPoints, m.upload, s.upload);

  const formatDist = (statObj, decimals = 1) => {
    if (!statObj) return '—';
    return `${statObj.min.toFixed(decimals)} / ${statObj.p50.toFixed(decimals)} / ${statObj.mean.toFixed(decimals)}`;
  };

  const statusLabels = {
    [METRIC_STATUS.MEASURED]: 'Medido',
    [METRIC_STATUS.UNAVAILABLE]: 'N/D',
    [METRIC_STATUS.FAILED]: 'Falha',
    [METRIC_STATUS.PENDING]: 'Pendente'
  };

  const rows = [
    {
      name: 'Download (Média)',
      value: formatMetricWithUnit(dlInfo.primary, 'Mbps', 2, dlInfo.status),
      samples: s.download?.count ?? 0,
      dist: formatDist(s.download, 1),
      status: statusLabels[dlInfo.status]
    },
    {
      name: 'Upload (Média)',
      value: formatMetricWithUnit(ulInfo.primary, 'Mbps', 2, ulInfo.status),
      samples: s.upload?.count ?? 0,
      dist: formatDist(s.upload, 1),
      status: statusLabels[ulInfo.status]
    },
    {
      name: 'Ping Ocioso (P50)',
      value: formatMetricWithUnit(m.ping.value, 'ms', 1, m.ping.status),
      samples: s.unloadedLatency?.count ?? 0,
      dist: formatDist(s.unloadedLatency, 1),
      status: statusLabels[m.ping.status]
    },
    {
      name: 'Jitter Ocioso',
      value: formatMetricWithUnit(m.jitter.value, 'ms', 2, m.jitter.status),
      samples: s.unloadedLatency?.count ?? 0,
      dist: '—',
      status: statusLabels[m.jitter.status]
    },
    {
      name: 'Latência sob Download (P50)',
      value:
        m.downloadLatency.status === METRIC_STATUS.MEASURED
          ? `${formatMetricWithUnit(m.downloadLatency.value, 'ms', 1, m.downloadLatency.status)} (${formatDeltaMs(m.downloadLatencyDelta.value)})`
          : formatMetricWithUnit(m.downloadLatency.value, 'ms', 1, m.downloadLatency.status),
      samples: s.downloadLatency?.count ?? 0,
      dist: formatDist(s.downloadLatency, 1),
      status: statusLabels[m.downloadLatency.status]
    },
    {
      name: 'Latência sob Upload (P50)',
      value:
        m.uploadLatency.status === METRIC_STATUS.MEASURED
          ? `${formatMetricWithUnit(m.uploadLatency.value, 'ms', 1, m.uploadLatency.status)} (${formatDeltaMs(m.uploadLatencyDelta.value)})`
          : formatMetricWithUnit(m.uploadLatency.value, 'ms', 1, m.uploadLatency.status),
      samples: s.uploadLatency?.count ?? 0,
      dist: formatDist(s.uploadLatency, 1),
      status: statusLabels[m.uploadLatency.status]
    },
    {
      name: 'Jitter sob Download',
      value: formatMetricWithUnit(m.downloadJitter.value, 'ms', 2, m.downloadJitter.status),
      samples: s.downloadLatency?.count ?? 0,
      dist: '—',
      status: statusLabels[m.downloadJitter.status]
    },
    {
      name: 'Jitter sob Upload',
      value: formatMetricWithUnit(m.uploadJitter.value, 'ms', 2, m.uploadJitter.status),
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
