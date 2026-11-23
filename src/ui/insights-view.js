/**
 * Renderização segura (somente createElement/textContent) dos 3 selos práticos
 * de uso, barra comparativa vs. teste anterior e painel de histórico recente.
 */

import { clearElement, createEl } from '../utils/formatters.js';

const LEVEL_TO_TONE = Object.freeze({
  otimo: 'good',
  bom: 'info',
  atencao: 'danger'
});

function formatSignedDelta(value, unit, decimals = 1, lowerIsBetter = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { text: 'N/D', tone: 'neutral' };
  }

  const threshold = decimals === 0 ? 0.5 : 0.05;
  if (Math.abs(value) < threshold) {
    return { text: `0 ${unit}`, tone: 'neutral' };
  }

  const sign = value > 0 ? '+' : '';
  const text = `${sign}${value.toFixed(decimals)} ${unit}`;
  const improved = lowerIsBetter ? value < 0 : value > 0;
  return {
    text,
    tone: improved ? 'good' : 'warning'
  };
}

function formatShortDateTime(rawTimestamp) {
  const d = new Date(rawTimestamp || '');
  if (Number.isNaN(d.getTime())) {
    return 'Data indisponível';
  }
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm} ${hh}:${min}`;
}

function formatEntryMetric(value, unit, decimals = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'N/D';
  }
  return `${value.toFixed(decimals)} ${unit}`;
}

/**
 * Atualiza a seção de 3 selos de uso real e o comparativo com o teste anterior.
 *
 * @param {import('../services/usage-verdict.js').UsageVerdict[]} verdicts
 * @param {{
 *   downloadDeltaMbps: number | null,
 *   uploadDeltaMbps: number | null,
 *   pingDeltaMs: number | null,
 *   loadedDeltaMs: number | null
 * } | null} comparisonDelta
 */
export function renderUsageVerdictsAndComparison(verdicts, comparisonDelta) {
  const section = document.getElementById('usageVerdictSection');
  const grid = document.getElementById('usageVerdictGrid');
  const deltaBar = document.getElementById('comparisonDeltaBar');
  if (!section || !grid) return;

  section.classList.remove('hidden');
  clearElement(grid);

  const list = Array.isArray(verdicts) ? verdicts : [];
  for (const item of list) {
    const tone = LEVEL_TO_TONE[item.level] || 'info';
    const card = createEl('article', 'card usage-verdict-card');

    const top = createEl('div', 'usage-verdict-top');
    top.appendChild(createEl('h3', 'usage-verdict-title', item.title));
    top.appendChild(createEl('span', `capability-pill tone-${tone}`, item.label));

    card.appendChild(top);
    card.appendChild(createEl('p', 'usage-verdict-reason', item.reason));
    grid.appendChild(card);
  }

  if (!deltaBar) return;
  clearElement(deltaBar);

  if (!comparisonDelta) {
    deltaBar.appendChild(
      createEl(
        'span',
        'comparison-delta-empty',
        'Primeiro teste registrado — execute outro para comparar.'
      )
    );
    return;
  }

  deltaBar.appendChild(createEl('span', 'comparison-delta-label', 'Vs. teste anterior:'));

  const dlDelta = formatSignedDelta(comparisonDelta.downloadDeltaMbps, 'Mbps', 1, false);
  const ulDelta = formatSignedDelta(comparisonDelta.uploadDeltaMbps, 'Mbps', 1, false);
  const pingDelta = formatSignedDelta(comparisonDelta.pingDeltaMs, 'ms', 0, true);
  const loadDelta = formatSignedDelta(comparisonDelta.loadedDeltaMs, 'ms', 0, true);

  const items = [
    { prefix: '↓', ...dlDelta },
    { prefix: '↑', ...ulDelta },
    { prefix: 'Ping', ...pingDelta },
    { prefix: 'Δ carga', ...loadDelta }
  ];

  for (const chip of items) {
    deltaBar.appendChild(
      createEl('span', `comparison-delta-chip tone-${chip.tone}`, `${chip.prefix} ${chip.text}`)
    );
  }
}

/**
 * Oculta os selos de uso durante uma nova medição em andamento.
 */
export function resetUsageVerdictsUI() {
  const section = document.getElementById('usageVerdictSection');
  const grid = document.getElementById('usageVerdictGrid');
  const deltaBar = document.getElementById('comparisonDeltaBar');
  if (section) {
    section.classList.add('hidden');
  }
  clearElement(grid);
  clearElement(deltaBar);
}

/**
 * Renderiza a lista discreta de até 10 testes recentes e atualiza os botões de exportação/limpeza.
 *
 * @param {any[]} entries
 */
export function renderRecentHistoryPanel(entries) {
  const listEl = document.getElementById('recentHistoryList');
  const emptyEl = document.getElementById('recentHistoryEmpty');
  const csvBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('recentExportCsvBtn')
  );
  const jsonBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('recentExportJsonBtn')
  );
  const clearBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('recentClearHistoryBtn')
  );

  const list = Array.isArray(entries) ? entries.slice(0, 10) : [];
  const hasItems = list.length > 0;

  if (csvBtn) csvBtn.disabled = !hasItems;
  if (jsonBtn) jsonBtn.disabled = !hasItems;
  if (clearBtn) clearBtn.disabled = !hasItems;
  if (emptyEl) emptyEl.classList.toggle('hidden', hasItems);

  if (!listEl) return;
  clearElement(listEl);

  for (const entry of list) {
    const li = createEl('li', 'recent-history-item');

    const metaRow = createEl('div', 'recent-history-meta');
    metaRow.appendChild(
      createEl(
        'span',
        'recent-history-time mono',
        `${formatShortDateTime(entry.timestamp)} · ${entry.ispName || 'TestAi'} (${entry.serverLabel || 'Edge'})`
      )
    );
    metaRow.appendChild(
      createEl('span', 'recent-history-stability', entry.stabilityLabel || '—')
    );

    const metricsText = `↓ ${formatEntryMetric(entry.downloadMbps, 'Mbps', 1)} · ↑ ${formatEntryMetric(entry.uploadMbps, 'Mbps', 1)} · Ping ${formatEntryMetric(entry.pingMs, 'ms', 0)} · Δ ${formatEntryMetric(entry.loadedDeltaMs, 'ms', 0)}`;
    const metricsRow = createEl('div', 'recent-history-metrics mono', metricsText);

    li.appendChild(metaRow);
    li.appendChild(metricsRow);
    listEl.appendChild(li);
  }
}
