/**
 * Módulo de visualização e controle da seção "Capacidade do Celular ou Aparelho Testado".
 */

import { evaluateDeviceComparison } from '../diagnostics/capability-advisor.js';
import { clearElement, createEl } from '../utils/formatters.js';

/**
 * @param {import('../types.js').SemanticTone | string} tone
 * @param {string} text
 */
export function showDeviceFeedback(tone, text) {
  const el = document.getElementById('deviceFeedback');
  if (!el) return;
  el.className = `device-feedback tone-${tone}`;
  el.textContent = text;
  el.classList.remove('hidden');
}

export function hideDeviceFeedback() {
  const el = document.getElementById('deviceFeedback');
  if (el) el.classList.add('hidden');
}

/**
 * @param {import('../types.js').DeviceSpec} device
 * @param {import('../types.js').SpeedTestResult | null} [lastResult]
 */
export function renderDeviceComparisonPanel(device, lastResult = null) {
  const panel = document.getElementById('deviceResultPanel');
  if (!panel || !device) return;

  const comparison = evaluateDeviceComparison(device, lastResult);
  if (!comparison) return;

  clearElement(panel);
  panel.classList.remove('hidden');

  // Cabeçalho do dispositivo com selo de categoria e status de teste
  const header = createEl('div', 'device-result-header');
  const titleBox = createEl('div', '');
  titleBox.appendChild(createEl('h3', 'device-result-title', comparison.deviceName));
  titleBox.appendChild(createEl('p', 'device-result-variant', comparison.regionalVariant));
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
      comparison.wifiBandAverages.isInferredFromCategory
        ? 'Estimativa prática em Mbps pela categoria do aparelho'
        : 'Estimativa prática em Mbps conforme o padrão Wi-Fi do aparelho'
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
      label: '3. Velocidade Medida Neste Navegador',
      value: comparison.tiers.measured,
      note: 'Reflete o aparelho em que este teste foi rodado (pode diferir do modelo pesquisado acima).'
    }
  ];

  tierItems.forEach((t) => {
    const box = createEl('div', 'device-tier-box');
    box.appendChild(createEl('span', 'device-tier-label', t.label));
    box.appendChild(createEl('strong', 'device-tier-val', t.value));
    if (t.note) {
      box.appendChild(createEl('span', 'device-tier-note', t.note));
    }
    tiersGrid.appendChild(box);
  });
  panel.appendChild(tiersGrid);

  // Ficha técnica resumida: Conectividade, Categoria e Hardware Detectado
  const specsGrid = createEl('div', 'device-specs-grid');
  const specRows = [
    ['Padrão Wi-Fi & Redes', comparison.compatibilitySummary],
    [
      'Classificação do Aparelho',
      `${comparison.category.tier} — ${comparison.category.summary}`
    ]
  ];
  if (comparison.hardwareSummary) {
    specRows.push(['Hardware Detectado', comparison.hardwareSummary]);
  }

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

export function createDevicePanelController({ deviceService, state }) {
  async function handleDeviceLookup(rawQuery) {
    const seq = ++state.deviceLookupSeq;
    const trimmed = String(rawQuery || '').trim();
    const btn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('deviceSearchBtn')
    );

    if (trimmed) {
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Consultando...';
      }
      showDeviceFeedback('info', `Consultando especificações de "${trimmed}"...`);
    }

    const lookup = await deviceService.lookupDevice(rawQuery);
    if (seq !== state.deviceLookupSeq) return;

    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Consultar Aparelho';
    }

    if (lookup.status === 'found' && lookup.device) {
      state.selectedDevice = lookup.device;
      hideDeviceFeedback();
      renderDeviceComparisonPanel(lookup.device, state.lastResult);
      return;
    }

    state.selectedDevice = null;
    const panel = document.getElementById('deviceResultPanel');
    if (panel) panel.classList.add('hidden');
    const feedbackTone = lookup.status === 'error' ? 'danger' : 'warning';
    showDeviceFeedback(feedbackTone, lookup.message || 'Dispositivo não encontrado.');
  }

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
        container.querySelectorAll('.chip-btn.is-active').forEach((el) => {
          el.classList.remove('is-active');
        });
        btn.classList.add('is-active');
        const input = /** @type {HTMLInputElement | null} */ (
          document.getElementById('deviceQueryInput')
        );
        if (input) input.value = label;
        handleDeviceLookup(label);
      });
      container.appendChild(btn);
    });
  }

  return {
    handleDeviceLookup,
    renderPopularDeviceChips
  };
}
