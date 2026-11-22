/**
 * Módulo de renderização do veredito simplificado e dos cards "O que posso fazer com minha internet?".
 */

import { clearElement, createEl, setText } from '../utils/formatters.js';

export const CAPABILITIES_SUBTITLE_IDLE =
  'Execute um teste para avaliar vídeos 4K, downloads, jogos, chamadas e casa conectada.';
export const CAPABILITIES_SUBTITLE_RUNNING =
  'Avaliando vídeos 4K, downloads, jogos e estabilidade sob carga...';
export const CAPABILITIES_SUBTITLE_READY =
  'Avaliação dinâmica baseada na velocidade e na estabilidade sob carga';

const SKELETON_CARD_COUNT = 4;

/**
 * @param {import('../types.js').DiagnosisResult} diagnosis
 */
export function renderSimpleVerdict(diagnosis) {
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

/**
 * Renderiza o esqueleto 2x2 no estado vazio ou durante medição ativa,
 * preservando simetria e evitando salto de layout na transição para os resultados.
 * @param {{ busy?: boolean, subtitle?: string }} [options]
 */
export function renderCapabilitiesSkeleton({ busy = false, subtitle } = {}) {
  const grid = document.getElementById('capabilitiesGrid');
  if (!grid) return;

  clearElement(grid);
  grid.classList.add('is-empty');
  grid.setAttribute('aria-busy', String(Boolean(busy)));

  for (let i = 0; i < SKELETON_CARD_COUNT; i += 1) {
    const card = createEl('article', 'capability-card capability-skeleton');
    card.setAttribute('aria-hidden', 'true');

    const top = createEl('div', 'capability-card-top');
    top.appendChild(createEl('span', 'skel-bar skel-title'));
    top.appendChild(createEl('span', 'skel-bar skel-pill'));
    card.appendChild(top);

    const lines = createEl('div', 'capability-skeleton-lines');
    lines.appendChild(createEl('span', 'skel-bar skel-line'));
    lines.appendChild(createEl('span', 'skel-bar skel-line skel-line-short'));
    card.appendChild(lines);

    grid.appendChild(card);
  }

  setText(
    'capabilitiesSubtitle',
    subtitle ?? (busy ? CAPABILITIES_SUBTITLE_RUNNING : CAPABILITIES_SUBTITLE_IDLE)
  );
}

/**
 * @param {import('../types.js').CapabilityCard[]} capabilities
 */
export function renderCapabilitiesGrid(capabilities) {
  const grid = document.getElementById('capabilitiesGrid');
  if (!grid) return;

  clearElement(grid);
  grid.classList.remove('is-empty');
  grid.setAttribute('aria-busy', 'false');
  setText('capabilitiesSubtitle', CAPABILITIES_SUBTITLE_READY);

  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    const empty = createEl('div', 'card empty-state');
    empty.appendChild(
      createEl(
        'p',
        'empty-state-text',
        'Não há dados suficientes para avaliar os cenários de uso.'
      )
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
