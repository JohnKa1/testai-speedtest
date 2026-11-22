/**
 * Módulo de visualização e controle da seção "Capacidade do Celular ou Aparelho Testado".
 */

import { evaluateDeviceComparison } from '../diagnostics/capability-advisor.js';
import { clearElement, createEl } from '../utils/formatters.js';
import { buildGoogleSearchUrl } from '../utils/google-search.js';

/** @type {Record<string, string>} */
const BRAND_SEARCH_NAME_BY_ID = Object.freeze({
  samsung: 'Samsung',
  apple: 'Apple',
  motorola: 'Motorola',
  xiaomi: 'Xiaomi',
  poco: 'POCO',
  realme: 'Realme',
  infinix: 'Infinix',
  outras: ''
});

/**
 * Retorna o nome de busca por brand.id para compor a consulta do Google (E9, E25).
 * Definido em um único ponto da UI; nunca passa brand.label ('xiaomi' -> 'Xiaomi', 'outras' -> '').
 *
 * @param {string | null | undefined} brandId
 * @returns {string}
 */
export function getBrandSearchName(brandId) {
  const key = String(brandId ?? '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(BRAND_SEARCH_NAME_BY_ID, key)
    ? BRAND_SEARCH_NAME_BY_ID[key]
    : '';
}

function buildGoogleFallbackLinkNode(url) {
  const link = /** @type {HTMLAnchorElement} */ (
    createEl('a', 'device-fallback-link is-secondary-action')
  );
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noopener noreferrer');
  link.setAttribute('href', url);
  link.setAttribute('aria-disabled', 'false');
  link.appendChild(
    document.createTextNode('Seu dispositivo não aparece? Pesquisar no Google ')
  );
  const arrow = createEl('span', '', '↗');
  arrow.setAttribute('aria-hidden', 'true');
  const sr = createEl('span', 'sr-only', '(abre em nova aba)');
  link.appendChild(arrow);
  link.appendChild(sr);
  return link;
}

/**
 * @param {import('../types.js').SemanticTone | string} tone
 * @param {string} text
 * @param {{ googleUrl?: string | null }} [options]
 */
export function showDeviceFeedback(tone, text, options = {}) {
  const el = document.getElementById('deviceFeedback');
  if (!el) return;
  el.className = `device-feedback tone-${tone}`;
  clearElement(el);

  if (options?.googleUrl) {
    const msgP = createEl('p', 'device-feedback-text');
    msgP.textContent = text;
    el.appendChild(msgP);
    el.appendChild(buildGoogleFallbackLinkNode(options.googleUrl));
  } else {
    el.textContent = text;
  }

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

/**
 * Ponto único de tradução do rótulo de exibição da marca na UI (E2).
 * Mantém o serviço inalterado e converte 'outras' em 'Outras marcas'.
 *
 * @param {{ id?: string, label?: string } | null | undefined} brand
 * @returns {string}
 */
export function getBrandDisplayLabel(brand) {
  if (!brand) return '';
  return brand.id === 'outras' ? 'Outras marcas' : String(brand.label || '');
}

/**
 * Extrai UM exemplo de modelo de brand.placeholder do serviço que resolva offline (E5, E10).
 *
 * @param {{ id?: string, placeholder?: string } | null | undefined} brand
 * @returns {{ exampleModel: string, placeholderText: string }}
 */
export function getBrandPlaceholderExample(brand) {
  const raw = String(brand?.placeholder || '')
    .replace(/^ex\.?:\s*/i, '')
    .replace(/\.{2,}$/, '');
  const firstExample = raw.split(',')[0]?.trim() || '';
  return {
    exampleModel: firstExample,
    placeholderText: firstExample ? `Ex.: ${firstExample}` : 'Digite o modelo...'
  };
}

export function createDevicePanelController({ deviceService, state }) {
  if (!state.selectedBrandId) {
    state.selectedBrandId = null;
  }

  let lastInteractionWasPointer = false;

  function getBrandsList() {
    return typeof deviceService.getSupportedBrands === 'function'
      ? deviceService.getSupportedBrands()
      : [];
  }

  function inferBrandIdFromText(text) {
    const lower = String(text || '').toLowerCase();
    if (/\b(?:samsung|galaxy)\b/.test(lower)) return 'samsung';
    if (/\b(?:apple|iphone|ipad)\b/.test(lower)) return 'apple';
    if (/\b(?:motorola|moto|edge|razr)\b/.test(lower)) return 'motorola';
    if (/\bpoco\b/.test(lower)) return 'poco';
    if (/\b(?:xiaomi|redmi|mi)\b/.test(lower)) return 'xiaomi';
    if (/\brealme\b/.test(lower)) return 'realme';
    if (/\binfinix\b/.test(lower)) return 'infinix';
    return null;
  }

  function clearSuggestions() {
    const box = document.getElementById('deviceSuggestionsBox');
    const container = document.getElementById('deviceLiveSuggestions');
    if (box) box.classList.add('hidden');
    if (container) clearElement(container);
  }

  function clearResultPanel() {
    state.selectedDevice = null;
    const panel = document.getElementById('deviceResultPanel');
    if (panel) {
      panel.classList.add('hidden');
      clearElement(panel);
    }
  }

  function syncGoogleFallbackLink(rawModel = '', { highlightAsAction = false } = {}) {
    const linkEl = /** @type {HTMLAnchorElement | null} */ (
      document.getElementById('deviceGoogleLink')
    );
    const searchBrand = getBrandSearchName(state.selectedBrandId);
    const url = buildGoogleSearchUrl(searchBrand, rawModel);

    if (!linkEl) return url;

    if (!linkEl.dataset?.guardBound) {
      if (linkEl.dataset) linkEl.dataset.guardBound = 'true';
      linkEl.addEventListener('click', (ev) => {
        if (linkEl.getAttribute('aria-disabled') === 'true' || !linkEl.getAttribute('href')) {
          if (typeof ev?.preventDefault === 'function') ev.preventDefault();
        }
      });
    }

    if (!url) {
      if (typeof linkEl.removeAttribute === 'function') {
        linkEl.removeAttribute('href');
      }
      linkEl.setAttribute('aria-disabled', 'true');
      linkEl.classList.remove('is-secondary-action');
      return null;
    }

    linkEl.setAttribute('href', url);
    linkEl.setAttribute('aria-disabled', 'false');
    linkEl.classList.toggle('is-secondary-action', Boolean(highlightAsAction));
    return url;
  }

  function renderLiveSuggestions(rawInput = '') {
    const box = document.getElementById('deviceSuggestionsBox');
    const container = document.getElementById('deviceLiveSuggestions');
    const titleEl = document.getElementById('deviceSuggestionsTitle');
    if (!box || !container || typeof deviceService.getBrandSuggestions !== 'function') return;

    const brandId = state.selectedBrandId;
    const trimmed = String(rawInput || '').trim();
    if (!brandId || !trimmed) {
      box.classList.add('hidden');
      clearElement(container);
      return;
    }

    const suggestions = deviceService.getBrandSuggestions(brandId, trimmed, 10);
    clearElement(container);

    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      box.classList.add('hidden');
      return;
    }

    if (titleEl) {
      titleEl.textContent = 'Modelos correspondentes:';
    }

    suggestions.forEach((item) => {
      const btn = createEl('button', 'chip-btn suggestion-chip', item.model);
      btn.type = 'button';
      btn.setAttribute('role', 'option');

      btn.addEventListener('click', () => {
        container.querySelectorAll('.chip-btn.is-active').forEach((el) => {
          el.classList.remove('is-active');
        });
        btn.classList.add('is-active');
        const input = /** @type {HTMLInputElement | null} */ (
          document.getElementById('deviceQueryInput')
        );
        if (input) {
          input.value = item.model;
        }
        handleDeviceLookup(item.model, { brandId });
      });

      container.appendChild(btn);
    });

    box.classList.remove('hidden');
  }

  function selectBrand(brandId, { focusInput = false, preserveInput = false } = {}) {
    const brands = getBrandsList();
    const brand = brands.find((b) => b.id === brandId);
    if (!brand) return;

    const displayLabel = getBrandDisplayLabel(brand);
    const { placeholderText } = getBrandPlaceholderExample(brand);
    state.selectedBrandId = brand.id;

    // Atualiza opções da Etapa 1 (rádios nativos + labels estilizados)
    const brandGrid = document.getElementById('deviceBrandGrid');
    if (brandGrid) {
      brandGrid.querySelectorAll('.brand-option').forEach((cardEl) => {
        const isCurrent = cardEl.getAttribute('data-brand-id') === brand.id;
        cardEl.classList.toggle('is-active', isCurrent);
      });
      brandGrid.querySelectorAll('.brand-radio').forEach((radioEl) => {
        const input = /** @type {HTMLInputElement} */ (radioEl);
        input.checked = input.value === brand.id;
      });
    }

    const brandStatus = document.getElementById('deviceBrandStatus');
    if (brandStatus) {
      brandStatus.textContent = `Marca selecionada: ${displayLabel}. Campo Modelo da ${displayLabel} disponível.`;
    }

    // Revela Passo 2 removendo .hidden (E4, E11)
    const step2 = document.getElementById('deviceModelStep');
    if (step2) {
      step2.classList.remove('hidden', 'is-locked');
    }

    const activeBadge = document.getElementById('deviceActiveBrandBadge');
    if (activeBadge) {
      activeBadge.textContent = displayLabel;
      activeBadge.classList.remove('hidden');
    }

    const step2Title = document.getElementById('deviceStep2Title');
    if (step2Title) {
      step2Title.textContent = `Digite o modelo ${displayLabel}`;
    }

    const labelEl = document.getElementById('deviceQueryLabel');
    if (labelEl) {
      labelEl.textContent = `Modelo da ${displayLabel}`;
    }

    const inputEl = /** @type {HTMLInputElement | null} */ (
      document.getElementById('deviceQueryInput')
    );
    const searchBtn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('deviceSearchBtn')
    );

    if (inputEl) {
      inputEl.disabled = false;
      inputEl.placeholder = placeholderText;
      if (!preserveInput) {
        inputEl.value = '';
      }
      if (focusInput && typeof inputEl.focus === 'function') {
        inputEl.focus();
      }
    }

    if (searchBtn) {
      searchBtn.disabled = false;
    }

    // Estado 5 (4.1): Troca de marca limpa a caixa, as opções coerentes, o resultado e o link do Google
    hideDeviceFeedback();
    if (!preserveInput) {
      clearSuggestions();
      clearResultPanel();
      syncGoogleFallbackLink('', { highlightAsAction: false });
    } else {
      const currentVal = inputEl ? inputEl.value : '';
      renderLiveSuggestions(currentVal);
      syncGoogleFallbackLink(currentVal, { highlightAsAction: false });
    }
  }

  function renderBrandCards() {
    const brandGrid = document.getElementById('deviceBrandGrid');
    if (!brandGrid) return;

    clearElement(brandGrid);
    const brands = getBrandsList();

    brands.forEach((brand) => {
      const displayLabel = getBrandDisplayLabel(brand);
      const isSelected = state.selectedBrandId === brand.id;
      const radioId = `device-brand-radio-${brand.id}`;

      const cell = createEl('div', 'brand-cell');
      const radio = /** @type {HTMLInputElement} */ (createEl('input', 'brand-radio sr-only'));
      radio.type = 'radio';
      radio.name = 'deviceBrand';
      radio.id = radioId;
      radio.value = brand.id;
      radio.checked = isSelected;

      const label = createEl('label', 'brand-option');
      label.setAttribute('for', radioId);
      label.setAttribute('data-brand-id', brand.id);
      if (isSelected) {
        label.classList.add('is-active');
      }

      const checkIcon = createEl('span', 'brand-option-check', '✓');
      checkIcon.setAttribute('aria-hidden', 'true');
      const textSpan = createEl('span', 'brand-option-label', displayLabel);

      label.appendChild(checkIcon);
      label.appendChild(textSpan);

      // E3, E13, E15: distingue interação por ponteiro (clique/toque) de navegação por setas no teclado
      const markPointerInteraction = () => {
        lastInteractionWasPointer = true;
      };
      label.addEventListener('pointerdown', markPointerInteraction);
      label.addEventListener('mousedown', markPointerInteraction);
      label.addEventListener('touchstart', markPointerInteraction, { passive: true });

      radio.addEventListener('keydown', (ev) => {
        if (
          ev.key === 'ArrowLeft' ||
          ev.key === 'ArrowRight' ||
          ev.key === 'ArrowUp' ||
          ev.key === 'ArrowDown' ||
          ev.key === ' ' ||
          ev.key === 'Spacebar'
        ) {
          lastInteractionWasPointer = false;
        }
      });

      radio.addEventListener('click', (ev) => {
        if (typeof ev.detail === 'number' && ev.detail > 0) {
          lastInteractionWasPointer = true;
        }
      });

      label.addEventListener('click', () => {
        // Caso o usuário clique novamente na marca que já estava selecionada, move o foco para a caixa
        if (state.selectedBrandId === brand.id) {
          const inputEl = /** @type {HTMLInputElement | null} */ (
            document.getElementById('deviceQueryInput')
          );
          if (inputEl && typeof inputEl.focus === 'function') {
            inputEl.focus();
          }
        }
      });

      radio.addEventListener('change', () => {
        if (radio.checked) {
          const shouldFocus = lastInteractionWasPointer;
          lastInteractionWasPointer = false;
          selectBrand(brand.id, { focusInput: shouldFocus, preserveInput: false });
        }
      });

      cell.appendChild(radio);
      cell.appendChild(label);
      brandGrid.appendChild(cell);
    });

    // Vincula listener de digitação em tempo real na Etapa 2
    const inputEl = /** @type {HTMLInputElement | null} */ (
      document.getElementById('deviceQueryInput')
    );
    if (inputEl && !inputEl.dataset.liveBound) {
      inputEl.dataset.liveBound = 'true';
      inputEl.addEventListener('input', () => {
        if (!state.selectedBrandId) {
          const inferred = inferBrandIdFromText(inputEl.value) || 'samsung';
          selectBrand(inferred, { focusInput: false, preserveInput: true });
        }
        renderLiveSuggestions(inputEl.value);
        syncGoogleFallbackLink(inputEl.value, { highlightAsAction: false });
      });
    }
    syncGoogleFallbackLink(inputEl ? inputEl.value : '', { highlightAsAction: false });
  }

  async function handleDeviceLookup(rawQuery, options = {}) {
    const seq = ++state.deviceLookupSeq;
    const trimmed = String(rawQuery || '').trim();
    const effectiveBrandId =
      options.brandId || state.selectedBrandId || inferBrandIdFromText(trimmed);

    if (effectiveBrandId && effectiveBrandId !== state.selectedBrandId) {
      selectBrand(effectiveBrandId, { focusInput: false, preserveInput: true });
    }

    const btn = /** @type {HTMLButtonElement | null} */ (
      document.getElementById('deviceSearchBtn')
    );

    if (trimmed) {
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Consultando...';
      }
      syncGoogleFallbackLink(trimmed, { highlightAsAction: false });
      showDeviceFeedback('info', `Consultando especificações de "${trimmed}"...`);
    }

    let lookup;
    try {
      lookup = await deviceService.lookupDevice(rawQuery, {
        brandId: effectiveBrandId
      });
    } catch {
      lookup = {
        status: 'error',
        device: null,
        origin: 'online',
        message: 'Não foi possível consultar agora.'
      };
    }
    if (seq !== state.deviceLookupSeq) return;

    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Consultar';
    }

    if (lookup.status === 'found' && lookup.device) {
      state.selectedDevice = lookup.device;
      hideDeviceFeedback();
      syncGoogleFallbackLink(trimmed, { highlightAsAction: false });
      renderDeviceComparisonPanel(lookup.device, state.lastResult);
      return;
    }

    state.selectedDevice = null;
    const panel = document.getElementById('deviceResultPanel');
    if (panel) panel.classList.add('hidden');

    if (lookup.status === 'empty' || !trimmed) {
      syncGoogleFallbackLink('', { highlightAsAction: false });
      showDeviceFeedback('warning', lookup.message || 'Informe o modelo do aparelho.');
      return;
    }

    const googleUrl = syncGoogleFallbackLink(trimmed, { highlightAsAction: true });

    if (lookup.status === 'error') {
      showDeviceFeedback('danger', 'Não foi possível consultar agora.', { googleUrl });
      return;
    }

    showDeviceFeedback(
      'warning',
      `Não encontramos “${trimmed}” nas fontes consultadas.`,
      { googleUrl }
    );
  }

  function renderPopularDeviceChips() {
    renderBrandCards();

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

        const inferredBrand = inferBrandIdFromText(label);
        if (inferredBrand) {
          selectBrand(inferredBrand, { focusInput: false, preserveInput: true });
        }

        const input = /** @type {HTMLInputElement | null} */ (
          document.getElementById('deviceQueryInput')
        );
        if (input) input.value = dev.model;
        renderLiveSuggestions(dev.model);
        handleDeviceLookup(dev.model, { brandId: inferredBrand });
      });
      container.appendChild(btn);
    });
  }

  return {
    handleDeviceLookup,
    renderPopularDeviceChips,
    renderBrandCards,
    selectBrand
  };
}
