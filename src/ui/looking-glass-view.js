/**
 * Controlador visual da aba Rota / Jogos (Looking Glass) no Modo Avançado.
 * Utiliza exclusivamente `createEl` / `document.createElement` e `textContent`.
 */

import { clearElement, createEl } from '../utils/formatters.js';
import {
  fetchLookingGlassPresets,
  runLookingGlassProbe
} from '../services/looking-glass.service.js';

function formatProbeMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'N/D';
  }
  return `${value.toFixed(1)} ms`;
}

/**
 * Renderiza o cartão de resultado da sonda TCP Looking Glass sem usar HTML dinâmico.
 *
 * @param {HTMLElement | null} container
 * @param {{
 *   target: string,
 *   resolvedIp: string,
 *   port: number,
 *   samplesMs: number[],
 *   minMs: number | null,
 *   avgMs: number | null,
 *   maxMs: number | null,
 *   jitterMs: number | null,
 *   packetLossPct: number
 * }} data
 */
export function renderLookingGlassResult(container, data) {
  if (!container || !data) return;

  clearElement(container);
  container.classList.remove('hidden');

  const header = createEl('div', 'lg-result-header');
  const destBlock = createEl('div');
  destBlock.appendChild(createEl('span', 'lg-metric-label', 'DESTINO SONDADO'));
  destBlock.appendChild(createEl('strong', 'lg-result-target mono', `${data.target}:${data.port}`));
  header.appendChild(destBlock);
  header.appendChild(
    createEl('span', 'pill mono', `IP resolvido: ${data.resolvedIp}`)
  );
  container.appendChild(header);

  const grid = createEl('div', 'lg-result-grid');
  const metrics = [
    { label: 'Mínimo', value: formatProbeMs(data.minMs) },
    { label: 'Média', value: formatProbeMs(data.avgMs) },
    { label: 'Máximo', value: formatProbeMs(data.maxMs) },
    { label: 'Jitter', value: formatProbeMs(data.jitterMs) },
    {
      label: 'Perda TCP',
      value: `${Number.isFinite(data.packetLossPct) ? data.packetLossPct.toFixed(0) : 0}%`
    }
  ];

  for (const item of metrics) {
    const box = createEl('div', 'lg-result-metric');
    box.appendChild(createEl('span', 'lg-metric-label', item.label));
    box.appendChild(createEl('span', 'lg-metric-val mono', item.value));
    grid.appendChild(box);
  }
  container.appendChild(grid);

  const samplesRow = createEl('div', 'lg-samples-row');
  samplesRow.appendChild(createEl('span', 'lg-metric-label', 'Amostras individuais:'));
  if (Array.isArray(data.samplesMs) && data.samplesMs.length > 0) {
    data.samplesMs.forEach((ms, idx) => {
      samplesRow.appendChild(
        createEl('span', 'lg-sample-chip mono', `#${idx + 1}: ${formatProbeMs(ms)}`)
      );
    });
  } else {
    samplesRow.appendChild(createEl('span', 'lg-sample-chip mono', 'Sem resposta TCP'));
  }
  container.appendChild(samplesRow);
}

/**
 * Inicializa os eventos e estados do painel Looking Glass na aba Rota / Jogos.
 *
 * @param {{
 *   getConfig?: () => any,
 *   fetchPresetsFn?: typeof fetchLookingGlassPresets,
 *   runProbeFn?: typeof runLookingGlassProbe
 * }} [options]
 */
export function setupLookingGlassPanel({
  getConfig,
  fetchPresetsFn = fetchLookingGlassPresets,
  runProbeFn = runLookingGlassProbe
} = {}) {
  const unavailableNotice = document.getElementById('lgUnavailableNotice');
  const controlsWrap = document.getElementById('lgControlsWrap');
  const presetsRow = document.getElementById('lgPresetsRow');
  const customForm = /** @type {HTMLFormElement | null} */ (
    document.getElementById('lgCustomForm')
  );
  const hostInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById('lgHostInput')
  );
  const portSelect = /** @type {HTMLSelectElement | null} */ (
    document.getElementById('lgPortSelect')
  );
  const runBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('lgRunBtn')
  );
  const statusText = document.getElementById('lgStatusText');
  const errorBox = document.getElementById('lgErrorBox');
  const resultCard = document.getElementById('lgResultCard');

  if (!controlsWrap && !unavailableNotice && !presetsRow) {
    return {
      refreshAvailability: async () => ({ available: false, presets: [] })
    };
  }

  let isProbing = false;

  const setError = (message) => {
    if (!errorBox) return;
    if (!message) {
      errorBox.classList.add('hidden');
      errorBox.textContent = '';
      return;
    }
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
  };

  const setBusy = (busy, message = '') => {
    isProbing = busy;
    if (runBtn) {
      runBtn.disabled = busy;
      runBtn.textContent = busy ? 'Sondando rota...' : 'Testar Rota';
    }
    if (hostInput) hostInput.disabled = busy;
    if (portSelect) portSelect.disabled = busy;
    if (presetsRow && typeof presetsRow.querySelectorAll === 'function') {
      const buttons = /** @type {NodeListOf<HTMLButtonElement>} */ (
        presetsRow.querySelectorAll('button')
      );
      buttons.forEach((btn) => {
        btn.disabled = busy;
      });
    }
    if (statusText) {
      statusText.textContent = message;
    }
  };

  const showUnavailable = () => {
    unavailableNotice?.classList.remove('hidden');
    controlsWrap?.classList.add('hidden');
    setError('');
    if (statusText) statusText.textContent = '';
  };

  const showAvailable = () => {
    unavailableNotice?.classList.add('hidden');
    controlsWrap?.classList.remove('hidden');
  };

  const executeProbe = async (payload, targetLabel) => {
    if (isProbing) return;
    setError('');
    setBusy(true, `Sondando rota para ${targetLabel}...`);

    try {
      const cfg = typeof getConfig === 'function' ? getConfig() : undefined;
      const outcome = await runProbeFn(payload, cfg);
      if (outcome.ok && outcome.result) {
        renderLookingGlassResult(resultCard, outcome.result);
        setBusy(false, 'Sonda TCP concluída (4 conexões sequenciais).');
      } else if (outcome.code === 'UNAVAILABLE') {
        setBusy(false, '');
        showUnavailable();
      } else {
        setBusy(false, '');
        setError(outcome.error || 'Não foi possível sondar o destino.');
      }
    } catch {
      setBusy(false, '');
      setError('Erro inesperado ao executar sonda de rota.');
    }
  };

  customForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (isProbing) return;
    const host = (hostInput?.value || '').trim();
    const port = Number(portSelect?.value || 443);
    if (!host) {
      setError('Informe um IP público ou domínio válido para testar a rota.');
      return;
    }
    executeProbe({ host, port }, `${host}:${port}`);
  });

  const refreshAvailability = async () => {
    const cfg = typeof getConfig === 'function' ? getConfig() : undefined;
    const { available, presets } = await fetchPresetsFn(cfg);
    if (!available) {
      showUnavailable();
      return { available: false, presets: [] };
    }

    showAvailable();
    if (presetsRow) {
      clearElement(presetsRow);
      for (const preset of presets) {
        const btn = createEl(
          'button',
          'btn-secondary lg-preset-btn',
          `${preset.label} (${preset.port})`
        );
        btn.setAttribute('type', 'button');
        btn.addEventListener('click', () => {
          executeProbe({ presetId: preset.id }, preset.label);
        });
        presetsRow.appendChild(btn);
      }
    }
    return { available: true, presets };
  };

  return { refreshAvailability };
}
