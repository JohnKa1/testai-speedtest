/**
 * Módulo de renderização e humanização do veredito simplificado no Modo Simples.
 */

import { setText } from '../utils/formatters.js';

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
