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
 * Traduz notações técnicas (`Δ +X ms ↓ / ↑`) do veredito para linguagem humana no Modo Simples,
 * preservando integralmente notas de pico isolado e picos recorrentes sob carga.
 *
 * @param {string | null | undefined} summary
 * @returns {string}
 */
export function humanizeSimpleVerdictSummary(summary) {
  const raw = String(summary || '');
  if (!raw) return '';

  const describePair = (dlRaw, ulRaw) => {
    const dl = Number(dlRaw);
    const ul = Number(ulRaw);
    if (!Number.isFinite(dl) && !Number.isFinite(ul)) {
      return 'variação de latência não medida durante download e upload';
    }
    const maxDelta = Math.max(Number.isFinite(dl) ? dl : 0, Number.isFinite(ul) ? ul : 0);
    if (maxDelta <= 0) {
      return 'sem aumento de latência durante download e upload';
    }
    if (maxDelta <= 15) {
      return 'aumento mínimo de latência sob carga';
    }
    if (maxDelta <= 40) {
      return 'aumento leve de latência sob carga';
    }
    return `aumento perceptível de latência (+${Math.round(maxDelta)} ms) sob carga`;
  };

  let out = raw;

  out = out.replace(
    /\s*e mínima variação sob saturação\s*\((?:Δ\s*)?(?:\+(\d+)\s*ms|N\/D)\s*↓\s*\/\s*(?:Δ\s*)?(?:\+(\d+)\s*ms|N\/D)\s*↑\)/gi,
    (_, dl, ul) => {
      const dlN = Number(dl);
      const ulN = Number(ul);
      if (dlN === 0 && ulN === 0) {
        return ', sem aumento de latência durante download e upload';
      }
      return `, com ${describePair(dl, ul)}`;
    }
  );

  out = out.replace(
    /\s*e variação mediana controlada sob carga\s*\((?:Δ\s*)?(?:\+(\d+)\s*ms|N\/D)\s*↓\s*\/\s*(?:Δ\s*)?(?:\+(\d+)\s*ms|N\/D)\s*↑\)/gi,
    (_, dl, ul) => {
      const dlN = Number(dl);
      const ulN = Number(ul);
      if (dlN === 0 && ulN === 0) {
        return ', sem aumento mediano de latência durante download e upload';
      }
      return `, com ${describePair(dl, ul)}`;
    }
  );

  out = out.replace(
    /\((?:Δ\s*)?(?:\+(\d+)\s*ms|N\/D)\s*↓\s*\/\s*(?:Δ\s*)?(?:\+(\d+)\s*ms|N\/D)\s*↑\)/gi,
    (_, dl, ul) => `(${describePair(dl, ul)})`
  );

  out = out.replace(
    /\(Δ\s*\+(\d+)\s*ms no download e Δ\s*\+(\d+)\s*ms no upload\)/gi,
    '(aumento de +$1 ms no download e +$2 ms no upload)'
  );

  out = out.replace(/Δ\s*\+(\d+)\s*ms/g, 'aumento de +$1 ms');
  out = out.replace(/Δ\s*N\/D/g, 'variação indisponível');

  return out;
}

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
  setText('simpleVerdictSummary', humanizeSimpleVerdictSummary(diagnosis.summary));
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
