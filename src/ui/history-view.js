/**
 * Módulo de renderização do histórico local e comparação lado a lado.
 */

import { compareHistoryRecords } from '../storage/history.storage.js';
import { renderHistoryChart } from '../components/charts.js';
import {
  clearElement,
  createEl,
  formatDateTime,
  formatDeltaMs,
  formatMetricWithUnit
} from '../utils/formatters.js';
import { isNonNegativeNumber, METRIC_STATUS } from '../utils/validators.js';

/**
 * @param {{
 *   state: { history: import('../types.js').HistoryRecord[], selectedForCompare: string[] },
 *   onDeleteRecord?: (id: string) => void,
 *   onToggleCompare?: (id: string) => void
 * }} params
 */
export function renderHistoryPanel({ state, onDeleteRecord, onToggleCompare }) {
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
    cb.addEventListener('change', () => onToggleCompare?.(rec.id));
    checkTd.appendChild(cb);
    tr.appendChild(checkTd);

    tr.appendChild(createEl('td', 'mono', formatDateTime(rec.timestamp)));
    tr.appendChild(
      createEl(
        'td',
        'mono',
        formatMetricWithUnit(
          rec.downloadMbps,
          'Mbps',
          1,
          isNonNegativeNumber(rec.downloadMbps)
            ? METRIC_STATUS.MEASURED
            : METRIC_STATUS.UNAVAILABLE
        )
      )
    );
    tr.appendChild(
      createEl(
        'td',
        'mono',
        formatMetricWithUnit(
          rec.uploadMbps,
          'Mbps',
          1,
          isNonNegativeNumber(rec.uploadMbps) ? METRIC_STATUS.MEASURED : METRIC_STATUS.UNAVAILABLE
        )
      )
    );
    tr.appendChild(
      createEl(
        'td',
        'mono',
        `${formatMetricWithUnit(
          rec.pingMs,
          'ms',
          0,
          isNonNegativeNumber(rec.pingMs) ? METRIC_STATUS.MEASURED : METRIC_STATUS.UNAVAILABLE
        )} / ${formatMetricWithUnit(
          rec.jitterMs,
          'ms',
          1,
          isNonNegativeNumber(rec.jitterMs) ? METRIC_STATUS.MEASURED : METRIC_STATUS.UNAVAILABLE
        )}`
      )
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
    delBtn.addEventListener('click', () => onDeleteRecord?.(rec.id));
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
