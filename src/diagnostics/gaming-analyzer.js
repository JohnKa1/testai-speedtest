/**
 * Analisador dedicado para jogos online competitivos e cooperativos.
 * Avalia latência ociosa, jitter, latência sob download/upload e estabilidade.
 * Mantém rigor técnico: diferencia claramente RTT até a borda Cloudflare
 * de ping real até servidores específicos de jogos.
 */

import { GAMING_THRESHOLDS } from '../config/speedtest.config.js';
import { METRIC_STATUS } from '../utils/validators.js';
import { formatDeltaMs, formatLatency } from '../utils/formatters.js';

/**
 * @param {import('../types.js').SpeedTestResult} result
 * @param {Record<string, any>} [customThresholds]
 * @returns {import('../types.js').GamingResult}
 */
export function evaluateGamingReadiness(result, customThresholds = {}) {
  const t = { ...GAMING_THRESHOLDS, ...customThresholds };
  const m = /** @type {Partial<import('../types.js').SpeedTestMetrics>} */ (
    result?.metrics || {}
  );

  const ping = m.ping?.status === METRIC_STATUS.MEASURED ? m.ping.value : null;
  const jitter = m.jitter?.status === METRIC_STATUS.MEASURED ? m.jitter.value : null;
  const dlLat =
    m.downloadLatency?.status === METRIC_STATUS.MEASURED ? m.downloadLatency.value : null;
  const ulLat =
    m.uploadLatency?.status === METRIC_STATUS.MEASURED ? m.uploadLatency.value : null;
  const dlDelta =
    m.downloadLatencyDelta?.status === METRIC_STATUS.MEASURED
      ? m.downloadLatencyDelta.value
      : null;
  const ulDelta =
    m.uploadLatencyDelta?.status === METRIC_STATUS.MEASURED
      ? m.uploadLatencyDelta.value
      : null;
  const dlJitter =
    m.downloadJitter?.status === METRIC_STATUS.MEASURED ? m.downloadJitter.value : null;
  const ulJitter =
    m.uploadJitter?.status === METRIC_STATUS.MEASURED ? m.uploadJitter.value : null;

  if (ping === null || result?.incomplete) {
    return {
      verdictCode: 'insufficient',
      severity: 'warning',
      badge: 'DADOS INSUFICIENTES',
      title: 'Avaliação Gaming incompleta',
      summary:
        'É necessário concluir a medição de latência ociosa e latência sob carga para estimar a estabilidade da conexão em jogos online.',
      pillars: [],
      genres: []
    };
  }

  const maxDelta = Math.max(dlDelta ?? 0, ulDelta ?? 0);
  const maxLoadedJitter = Math.max(jitter ?? 0, dlJitter ?? 0, ulJitter ?? 0);

  let verdictCode = 'competitive';
  /** @type {'good' | 'warning' | 'danger'} */
  let severity = 'good';
  let badge = 'PRONTO PARA COMPETITIVO';
  let title = 'Características altamente favoráveis para jogos online';
  let summary =
    'Baixa latência de resposta até a borda da rede, jitter reduzido e bom controle de fila mesmo quando a banda é exigida.';

  if (ping > t.pingLagRiskMax || (jitter !== null && jitter > 25)) {
    verdictCode = 'unfavorable';
    severity = 'danger';
    badge = 'DESFAVORÁVEL PARA COMPETITIVO';
    title = 'Risco elevado de atraso e perda de sincronia em partidas';
    summary =
      'A latência base ou a oscilação entre pacotes está acima do recomendado para jogos de ação rápida, podendo causar atraso perceptível no registro de comandos.';
  } else if (
    ping > t.pingPlayableMax ||
    (jitter !== null && jitter > t.jitterPlayableMax) ||
    maxDelta > t.loadedDeltaPlayableMax
  ) {
    verdictCode = 'lag-under-load';
    severity = 'warning';
    badge = 'RISCO DE LAG SOB CARGA';
    title = 'Jogável em rede livre, mas sensível a uso simultâneo';
    summary =
      'Embora a conexão suporte partidas online, variações de jitter ou aumento de latência durante downloads/uploads podem provocar picos de ping (lag spikes) se outros dispositivos usarem a rede.';
  } else if (
    ping > t.pingCompetitiveMax ||
    (jitter !== null && jitter > t.jitterCompetitiveMax) ||
    maxDelta > t.loadedDeltaCompetitiveMax
  ) {
    verdictCode = 'playable';
    severity = 'good';
    badge = 'ADEQUADO PARA JOGOS ONLINE';
    title = 'Boa estabilidade geral para partidas online';
    summary =
      'Os indicadores de latência e estabilidade atendem bem à maioria dos títulos online, com pequena margem de variação sob carga intensa.';
  }

  const pillars = [
    {
      label: 'Resposta Base (Ping Ocioso)',
      value: `${formatLatency(ping)} ms`,
      status:
        ping <= t.pingCompetitiveMax
          ? 'Excelente'
          : ping <= t.pingPlayableMax
            ? 'Adequado'
            : 'Elevado',
      detail: 'Tempo de ida e volta até o PoP Cloudflare sem carga concorrente.'
    },
    {
      label: 'Consistência Temporal (Jitter)',
      value: `${formatLatency(jitter, 1)} ms`,
      status:
        jitter !== null && jitter <= t.jitterCompetitiveMax
          ? 'Muito estável'
          : jitter !== null && jitter <= t.jitterPlayableMax
            ? 'Estável'
            : 'Oscilante',
      detail: `Variação em repouso; pico de jitter observado sob carga: ${formatLatency(maxLoadedJitter, 1)} ms.`
    },
    {
      label: 'Resiliência sob Download',
      value: `${formatLatency(dlLat)} ms (${formatDeltaMs(dlDelta)})`,
      status:
        dlDelta !== null && dlDelta <= t.loadedDeltaCompetitiveMax
          ? 'Protegido'
          : dlDelta !== null && dlDelta <= t.loadedDeltaPlayableMax
            ? 'Moderado'
            : 'Sensível',
      detail: 'Impacto no ping caso uma atualização ou streaming inicie durante a partida.'
    },
    {
      label: 'Resiliência sob Upload',
      value: `${formatLatency(ulLat)} ms (${formatDeltaMs(ulDelta)})`,
      status:
        ulDelta !== null && ulDelta <= t.loadedDeltaCompetitiveMax
          ? 'Protegido'
          : ulDelta !== null && ulDelta <= t.loadedDeltaPlayableMax
            ? 'Moderado'
            : 'Sensível',
      detail: 'Impacto no ping durante chat de voz, transmissão (stream) ou envio de arquivos.'
    }
  ];

  /** @type {import('../types.js').GamingGenreFit[]} */
  const genres = [
    {
      category: 'FPS Tático & Battle Royale (ex.: CS2, Valorant, Fortnite, PUBG)',
      fit:
        ping <= t.pingCompetitiveMax &&
        (jitter ?? 0) <= t.jitterCompetitiveMax &&
        maxDelta <= t.loadedDeltaPlayableMax
          ? 'Alta aderência'
          : ping <= t.pingPlayableMax
            ? 'Viável com rede dedicada'
            : 'Sujeito a atraso competitivo',
      tone:
        ping <= t.pingCompetitiveMax &&
        (jitter ?? 0) <= t.jitterCompetitiveMax &&
        maxDelta <= t.loadedDeltaPlayableMax
          ? 'good'
          : ping <= t.pingPlayableMax
            ? 'warning'
            : 'danger',
      note: 'Exigem jitter mínimo e ausência de picos durante trocas de tiros. Utilize cabo Ethernet sempre que possível.'
    },
    {
      category: 'MOBA, Luta & Esportes (ex.: League of Legends, EA FC)',
      fit:
        ping <= t.pingPlayableMax && (jitter ?? 0) <= t.jitterPlayableMax
          ? 'Boa experiência'
          : 'Sensível a picos de jitter',
      tone: ping <= t.pingPlayableMax && (jitter ?? 0) <= t.jitterPlayableMax ? 'good' : 'warning',
      note: 'Toleram ligeiramente mais latência fixa do que FPS, mas sofrem imediatamente com variação brusca de jitter.'
    },
    {
      category: 'MMORPG, Cooperativo & Casual',
      fit: ping <= 110 ? 'Plenamente adequado' : 'Atraso perceptível',
      tone: ping <= 110 ? 'good' : 'warning',
      note: 'Funcionam bem mesmo em conexões intermediárias, desde que não haja queda de pacotes.'
    }
  ];

  return {
    verdictCode,
    severity,
    badge,
    title,
    summary,
    pillars,
    genres
  };
}