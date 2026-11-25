/**
 * Motor de diagnóstico multidimensional de rede do TestAi.
 * Avalia conjuntamente download, upload, ping ocioso, jitter ocioso,
 * latência/jitter sob download e upload, deltas sob carga e estabilidade sustentada.
 */

import { DIAGNOSTIC_THRESHOLDS } from '../config/speedtest.config.js';
import {
  evaluateLoadedLatencySpikes,
  evaluateProbeLoss,
  STABILITY_RULES
} from './stability-rules.js';
import { isNonNegativeNumber, METRIC_STATUS } from '../utils/validators.js';
import {
  computeStats,
  formatDeltaMs,
  formatLatency,
  formatMetricWithUnit,
  formatSpeed,
  getCanonicalSpeedMeta
} from '../utils/formatters.js';

/**
 * Analisa amostras individuais de latência sob carga (download e upload) para
 * detectar picos isolados (leves ou severos via Spike Guard) ou recorrentes.
 *
 * @param {{
 *   metrics?: Partial<import('../types.js').SpeedTestMetrics>,
 *   series?: Partial<import('../types.js').SpeedTestResult['series']>
 * }} result
 * @param {{
 *   spikeDeltaThresholdMs?: number,
 *   severeDeltaThresholdMs?: number,
 *   recurrentCountMin?: number,
 *   recurrentRatioMin?: number
 * }} [options]
 * @returns {import('../types.js').LoadedLatencySpikes}
 */
export function analyzeLoadedLatencySpikes(result, options = {}) {
  return evaluateLoadedLatencySpikes(result, options);
}

export const DIAGNOSIS_CATALOG = Object.freeze({
  EXCELLENT: 'excellent',
  GOOD: 'good',
  LIMITED_SPEED: 'limited-speed',
  HIGH_LATENCY: 'high-latency',
  HIGH_JITTER: 'high-jitter',
  POSSIBLE_CONGESTION: 'possible-congestion',
  POSSIBLE_BUFFERBLOAT: 'possible-bufferbloat',
  DOWNLOAD_INSTABILITY: 'download-instability',
  UPLOAD_INSTABILITY: 'upload-instability',
  INCONCLUSIVE: 'inconclusive',
  POSSIBLE_WIFI_LIMITATION: 'possible-wifi-limitation'
});

/**
 * Calcula estatísticas de vazão sustentada priorizando janelas/blocos >= 1 MB
 * para filtrar amostras mínimas iniciais, mantendo fallback automático em links lentos (< 8 Mbps).
 */
function getSustainedThroughputStats(points, fallbackStats) {
  if (!Array.isArray(points) || points.length === 0) {
    return fallbackStats;
  }
  const largeBlocks = points.filter((p) => (p.bytes ?? 0) >= 1_000_000);
  if (largeBlocks.length >= 4) {
    return computeStats(largeBlocks.map((p) => p.mbps)) || fallbackStats;
  }
  return fallbackStats;
}

/**
 * @param {import('../types.js').SpeedTestResult} result
 * @param {Record<string, any>} [customThresholds]
 * @returns {import('../types.js').DiagnosisResult}
 */
export function evaluateConnection(result, customThresholds = {}) {
  const t = { ...DIAGNOSTIC_THRESHOLDS, ...customThresholds };
  const m = /** @type {Partial<import('../types.js').SpeedTestMetrics>} */ (
    result?.metrics || {}
  );
  const stats = /** @type {Partial<import('../types.js').SpeedTestResult['stats']>} */ (
    result?.stats || {}
  );
  const series = /** @type {Partial<import('../types.js').SpeedTestResult['series']>} */ (
    result?.series || {}
  );
  const ctx = /** @type {Partial<import('../types.js').SpeedTestResult['context']>} */ (
    result?.context || {}
  );

  const dl = m.download?.status === METRIC_STATUS.MEASURED ? m.download.value : null;
  const ul = m.upload?.status === METRIC_STATUS.MEASURED ? m.upload.value : null;
  const ping = m.ping?.status === METRIC_STATUS.MEASURED ? m.ping.value : null;
  const speedMeta = getCanonicalSpeedMeta(result?.measurementMode);
  const rawSpikes = result?.loadedSpikes || analyzeLoadedLatencySpikes(result);
  const loadedSpikes =
    typeof rawSpikes?.hasSevereSpike === 'boolean'
      ? rawSpikes
      : evaluateLoadedLatencySpikes(result);
  const probeLoss = evaluateProbeLoss(result);
  const jitter = m.jitter?.status === METRIC_STATUS.MEASURED ? m.jitter.value : null;
  const dlLat =
    m.downloadLatency?.status === METRIC_STATUS.MEASURED ? m.downloadLatency.value : null;
  const ulLat =
    m.uploadLatency?.status === METRIC_STATUS.MEASURED ? m.uploadLatency.value : null;
  const dlJitter =
    m.downloadJitter?.status === METRIC_STATUS.MEASURED ? m.downloadJitter.value : null;
  const ulJitter =
    m.uploadJitter?.status === METRIC_STATUS.MEASURED ? m.uploadJitter.value : null;
  const dlDelta =
    m.downloadLatencyDelta?.status === METRIC_STATUS.MEASURED
      ? m.downloadLatencyDelta.value
      : null;
  const ulDelta =
    m.uploadLatencyDelta?.status === METRIC_STATUS.MEASURED
      ? m.uploadLatencyDelta.value
      : null;

  const dlSamples = stats.download?.count ?? 0;
  const ulSamples = stats.upload?.count ?? 0;
  const pingSamples = stats.unloadedLatency?.count ?? 0;

  const sustainedDlStats = getSustainedThroughputStats(series.downloadPoints, stats.download);
  const sustainedUlStats = getSustainedThroughputStats(series.uploadPoints, stats.upload);

  const dlCv = sustainedDlStats?.cv ?? 0;
  const ulCv = sustainedUlStats?.cv ?? 0;

  const contractedRatio =
    isNonNegativeNumber(ctx.contractedMbps) &&
    ctx.contractedMbps > 0 &&
    isNonNegativeNumber(dl)
      ? dl / ctx.contractedMbps
      : null;

  // --------------------------------------------------------------------------
  // 1. VERIFICAÇÃO DE COMPLETUDE / RESULTADOS INCONCLUSIVOS
  // --------------------------------------------------------------------------
  const missingCore =
    dl === null ||
    ul === null ||
    ping === null ||
    result?.incomplete === true ||
    dlSamples < t.minThroughputPoints ||
    ulSamples < t.minThroughputPoints ||
    pingSamples < t.minLatencyPoints;

  if (missingCore) {
    const uploadFailedOnly =
      dl !== null &&
      ping !== null &&
      (ul === null || m.upload?.status === METRIC_STATUS.FAILED || ulSamples < t.minThroughputPoints);

    return buildResult({
      code: DIAGNOSIS_CATALOG.INCONCLUSIVE,
      severity: 'warning',
      title: uploadFailedOnly
        ? 'Medição parcial: falha no envio (upload) para a internet'
        : 'Resultados inconclusivos ou medição parcial',
      summary: uploadFailedOnly
        ? 'O download e o ping foram medidos, mas o envio de dados deste dispositivo/rede local para a internet apresentou falha ou instabilidade antes da conclusão do teste.'
        : 'Não foi possível reunir todas as amostras essenciais de download, upload e latência ociosa com estabilidade suficiente para um veredito definitivo.',
      observed: `Download: ${formatMetricWithUnit(dl, 'Mbps', 1, m.download?.status)} (${dlSamples} amostras) · Upload: ${formatMetricWithUnit(ul, 'Mbps', 1, m.upload?.status)} (${ulSamples} amostras) · Ping ocioso: ${formatMetricWithUnit(ping, 'ms', 0, m.ping?.status)} (${pingSamples} amostras).`,
      basisMetrics: [
        'Completude das séries de download, upload e RTT ocioso',
        `Amostras coletadas: ↓ ${dlSamples}, ↑ ${ulSamples}, RTT ${pingSamples}`
      ],
      meaning: uploadFailedOnly
        ? 'Sem concluir a etapa de envio (upload), não é possível confirmar a qualidade de videochamadas, lives ou backups — o gargalo pode estar no caminho de saída do dispositivo ou rede local para a internet (Wi-Fi, sinal ou bloqueios), sem indicar automaticamente falha no provedor.'
        : 'Sem a conclusão integral das fases de carga e repouso, qualquer classificação de qualidade pode mascarar gargalos reais de subida ou degradação sob saturação.',
      probableCauses: uploadFailedOnly
        ? [
            'Atenuação ou interferência no sinal Wi-Fi no canal de retorno (upstream) do dispositivo até o roteador.',
            'Bloqueio, inspeção de tráfego ou interrupção de requisições POST por VPN, firewall, proxy ou extensão de navegador.',
            'Saturação temporária no envio por backups/sincronizações locais ou instabilidade momentânea no enlace.'
          ]
        : [
            'Interrupção manual ou perda temporária de conectividade durante uma das etapas do teste.',
            'Bloqueio parcial de requisições HTTP/TLS por firewall, extensão de navegador ou proxy.',
            'Instabilidade severa no enlace local impedindo o fechamento das transferências maiores.'
          ],
      userActions: uploadFailedOnly
        ? [
            'Repita o teste próximo ao roteador (em Wi-Fi 5/6 GHz) ou via cabo Ethernet para isolar o caminho de envio do dispositivo.',
            'Desative temporariamente VPNs, proxies ou bloqueadores e pause uploads em segundo plano antes de acionar o suporte.'
          ]
        : [
            'Repita o teste completo sem pausar ou alternar redes durante a execução.',
            'Desative temporariamente VPNs, proxies ou bloqueadores de script que possam interromper sondagens.'
          ],
      confirmatoryTest: uploadFailedOnly
        ? 'Executar novamente próximo ao roteador ou via cabo Ethernet para confirmar se o envio do dispositivo/rede local estabiliza.'
        : 'Executar uma nova rodada completa no perfil Padrão Adaptativo com abas e downloads em segundo plano encerrados.',
      secondaryFindings: []
    });
  }

  // --------------------------------------------------------------------------
  // 2. COLETA DE INDICADORES MULTIDIMENSIONAIS
  // --------------------------------------------------------------------------
  const findings = [];

  const maxLoadedDelta = Math.max(dlDelta ?? 0, ulDelta ?? 0);
  const moderateDeltaMin =
    t.loadedDeltaModerateMin ?? STABILITY_RULES.loadedDeltaModerateMinMs;
  const hasSevereLoadedLatency =
    (dlDelta !== null && dlDelta >= t.loadedDeltaBufferbloatMin) ||
    (ulDelta !== null && ulDelta >= t.loadedDeltaBufferbloatMin);

  const hasModerateLoadedLatency =
    !hasSevereLoadedLatency &&
    ((dlDelta !== null && dlDelta >= moderateDeltaMin) ||
      (ulDelta !== null && ulDelta >= moderateDeltaMin) ||
      (dlDelta !== null &&
        dlDelta > t.loadedDeltaGoodMax &&
        ulDelta !== null &&
        ulDelta > t.loadedDeltaGoodMax));

  const hasHighIdlePing = ping > t.idlePingGoodMax;
  const hasHighIdleJitter = jitter !== null && jitter > t.jitterElevatedMax;

  const hasDownloadInstability =
    (sustainedDlStats?.count ?? 0) >= 4 && dlCv >= t.throughputCvInstabilityMin;

  const hasUploadInstability =
    (sustainedUlStats?.count ?? 0) >= 4 && ulCv >= t.throughputCvInstabilityMin;

  const hasSpeedLimit =
    dl < t.lowDownloadMbps ||
    ul < t.lowUploadMbps ||
    (contractedRatio !== null && contractedRatio < t.contractDeliveryRatioMin);

  const declaredWifi =
    ctx.linkType === 'wifi-24' || ctx.linkType === 'wifi-5-6';
  const wifiSymptomPattern =
    ctx.linkType !== 'ethernet' &&
    ctx.linkType !== 'movel' &&
    (declaredWifi ||
      (dl < 120 && (ping > 25 || (jitter !== null && jitter > 10) || maxLoadedDelta > 30)));

  // --------------------------------------------------------------------------
  // 3. CONSTRUÇÃO DOS ACHADOS POR DIMENSÃO
  // --------------------------------------------------------------------------

  if (hasSevereLoadedLatency) {
    const worseDirection =
      (ulDelta ?? 0) >= (dlDelta ?? 0) ? 'upload' : 'download';
    findings.push({
      code: DIAGNOSIS_CATALOG.POSSIBLE_BUFFERBLOAT,
      severity: 'danger',
      priority: 100,
      title: 'Possível bufferbloat (aumento acentuado de latência sob carga)',
      summary: `A latência ociosa de ${formatLatency(ping)} ms elevou-se para ${formatLatency(dlLat)} ms no download (${formatDeltaMs(dlDelta)}) e ${formatLatency(ulLat)} ms no upload (${formatDeltaMs(ulDelta)}).`,
      observed: `Ping ocioso em ${formatLatency(ping)} ms saltando até ${formatLatency(Math.max(dlLat ?? 0, ulLat ?? 0))} ms sob saturação (${worseDirection} mais sensível).`,
      basisMetrics: [
        `Ping ocioso: ${formatLatency(ping)} ms`,
        `Latência sob download: ${formatLatency(dlLat)} ms (${formatDeltaMs(dlDelta)})`,
        `Latência sob upload: ${formatLatency(ulLat)} ms (${formatDeltaMs(ulDelta)})`
      ],
      meaning:
        'Quando o link atinge sua capacidade máxima, pacotes interativos (voz, vídeo, jogos e navegação) ficam retidos em filas extensas antes de serem transmitidos, causando travamentos momentâneos mesmo com boa banda nominal.',
      probableCauses: [
        'Hipótese principal: enfileiramento excessivo (bufferbloat) no roteador doméstico, ONT ou modem por ausência de gerenciamento ativo de filas (SQM / fq_codel / CAKE).',
        'Hipótese alternativa: saturação simultânea por outros dispositivos na rede local (backups em nuvem, torrents ou streaming 4K) durante o teste.',
        'Hipótese de acesso: contenção de meio físico em rede Wi-Fi congestionada.'
      ],
      userActions: [
        'Ative recursos de QoS Inteligente / SQM (Smart Queue Management) no roteador, limitando a banda configurada a cerca de 90–95% da velocidade real.',
        'Verifique se há uploads pesados ou sincronização em nuvem ocorrendo em outros dispositivos da rede.'
      ],
      confirmatoryTest:
        'Repetir o teste conectado via cabo Ethernet diretamente ao roteador principal, sem outros dispositivos ativos na rede, para isolar o equipamento do Wi-Fi.'
    });
  }

  if (hasModerateLoadedLatency) {
    findings.push({
      code: DIAGNOSIS_CATALOG.POSSIBLE_CONGESTION,
      severity: 'warning',
      priority: 82,
      title: 'Possível congestionamento sob tráfego intenso',
      summary: `Houve elevação moderada da latência durante a transferência de dados (${formatDeltaMs(dlDelta)} no download e ${formatDeltaMs(ulDelta)} no upload), sem atingir níveis críticos de retenção.`,
      observed: `Ping ocioso de ${formatLatency(ping)} ms com variação sob carga de ${formatDeltaMs(dlDelta)} (↓) e ${formatDeltaMs(ulDelta)} (↑).`,
      basisMetrics: [
        `Ping ocioso: ${formatLatency(ping)} ms`,
        `Δ Latência download: ${formatDeltaMs(dlDelta)}`,
        `Δ Latência upload: ${formatDeltaMs(ulDelta)}`
      ],
      meaning:
        'Em condições normais de navegação a resposta é estável, mas transferências simultâneas pesadas podem adicionar atraso perceptível em chamadas ou jogos.',
      probableCauses: [
        'Hipótese: disputa de fila no roteador ou no ponto de agregação do provedor durante picos de uso.',
        'Hipótese: interferência ou compartilhamento de canal em ambiente Wi-Fi.'
      ],
      userActions: [
        'Evite downloads ou backups volumosos enquanto participa de reuniões por vídeo ou partidas competitivas.',
        'Se utilizar Wi-Fi, priorize a faixa de 5 GHz ou 6 GHz próxima ao ponto de acesso.'
      ],
      confirmatoryTest:
        'Realizar duas medições em horários distintos (horário comercial vs. horário de pico noturno) via cabo Ethernet para verificar variação de carga no provedor.'
    });
  }

    if (!hasSevereLoadedLatency && loadedSpikes.status === 'recurrent' && loadedSpikes.peakMs !== null) {
      findings.push({
        code: DIAGNOSIS_CATALOG.POSSIBLE_CONGESTION,
        severity: 'warning',
        priority: 85,
        title: 'Instabilidade de latência sob carga (picos recorrentes)',
        summary: `Apesar da mediana sob carga controlada (${formatDeltaMs(dlDelta)} ↓ / ${formatDeltaMs(ulDelta)} ↑), ${loadedSpikes.spikeCount} de ${loadedSpikes.totalSamples} amostras apresentaram picos de até ${Math.round(loadedSpikes.peakMs)} ms durante o ${loadedSpikes.peakPhase}.`,
        observed: `${loadedSpikes.spikeCount} amostras acima do patamar de pico (+${loadedSpikes.thresholdDeltaMs} ms), atingindo ${Math.round(loadedSpikes.peakMs)} ms no ${loadedSpikes.peakPhase}.`,
        basisMetrics: [
          `Ping ocioso: ${formatLatency(ping)} ms`,
          `Pico sob carga (${loadedSpikes.peakPhase}): ${Math.round(loadedSpikes.peakMs)} ms`,
          `Picos recorrentes: ${loadedSpikes.spikeCount}/${loadedSpikes.totalSamples} amostras`
        ],
        meaning:
          'Picos intermitentes durante tráfego intenso causam engasgos momentâneos (spikes) em jogos competitivos e micro-cortes em chamadas de vídeo, mesmo quando a mediana parece baixa.',
        probableCauses: [
          'Hipótese: enfileiramento pontual de pacotes (micro-bufferbloat) em rajadas de envio/recepção sem controle SQM.',
          'Hipótese: contenção temporária de meio Wi-Fi ou interferência intermitente.'
        ],
        userActions: [
          'Se utilizar Wi-Fi para jogos ou reuniões, teste via cabo Ethernet ou ative QoS/SQM no roteador.'
        ],
        confirmatoryTest:
          'Executar o perfil Estabilidade Prolongada via cabo para observar se os picos sob carga desaparecem.'
      });
    }

    if (
      !hasSevereLoadedLatency &&
      loadedSpikes.status === 'isolated' &&
      loadedSpikes.hasSevereSpike &&
      loadedSpikes.peakMs !== null
    ) {
      findings.push({
        code: DIAGNOSIS_CATALOG.POSSIBLE_CONGESTION,
        severity: 'warning',
        priority: 83,
        title: 'Pico severo isolado de latência sob carga',
        summary: `Apesar da mediana sob carga controlada (${formatDeltaMs(dlDelta)} ↓ / ${formatDeltaMs(ulDelta)} ↑), foi registrado um pico severo de ${Math.round(loadedSpikes.peakMs)} ms durante o ${loadedSpikes.peakPhase}.`,
        observed: `Pico isolado severo (+${Math.round(loadedSpikes.peakDeltaMs ?? 0)} ms acima do ping em repouso), atingindo ${Math.round(loadedSpikes.peakMs)} ms no ${loadedSpikes.peakPhase}.`,
        basisMetrics: [
          `Ping ocioso: ${formatLatency(ping)} ms`,
          `Pico severo sob carga (${loadedSpikes.peakPhase}): ${Math.round(loadedSpikes.peakMs)} ms`,
          `Amostras com pico: ${loadedSpikes.spikeCount}/${loadedSpikes.totalSamples}`
        ],
        meaning:
          'Um salto pontual acima de 250 ms sob saturação indica retenção aguda momentânea de fila ou pausa de rádio/interface, capaz de causar engasgo perceptível em jogos e chamadas em tempo real.',
        probableCauses: [
          'Hipótese: rajada inicial de enfileiramento no roteador/ONT antes da estabilização da janela TCP.',
          'Hipótese: varredura de canal (roaming/background scan) ou contenção momentânea no adaptador Wi-Fi.'
        ],
        userActions: [
          'Repita a medição via cabo Ethernet ou ative QoS/SQM no roteador caso perceba travamentos pontuais em uso simultâneo.'
        ],
        confirmatoryTest:
          'Executar o perfil Estabilidade Prolongada para verificar se o pico acima de 250 ms volta a ocorrer.'
      });
    }

    if (probeLoss.hasRelevantLoss) {
      findings.push({
        code: probeLoss.isSevereLoss
          ? DIAGNOSIS_CATALOG.POSSIBLE_BUFFERBLOAT
          : DIAGNOSIS_CATALOG.POSSIBLE_CONGESTION,
        severity: probeLoss.isSevereLoss ? 'danger' : 'warning',
        priority: probeLoss.isSevereLoss ? 96 : 86,
        title: probeLoss.isSevereLoss
          ? 'Perda acentuada de sondas de latência sob saturação'
          : 'Falhas ou timeouts parciais nas sondas de latência',
        summary: `Durante a medição (${probeLoss.worstPhase}), ${Math.round(probeLoss.worstLossPct)}% das sondas de latência expiraram ou falharam (${probeLoss.loadedTimeouts} timeout(s) sob carga), indicando saturação de fila além das amostras respondidas.`,
        observed: `Perda máxima de sondas em ${Math.round(probeLoss.worstLossPct)}% na fase ${probeLoss.worstPhase} (${probeLoss.totalFailures} falha(s) no total).`,
        basisMetrics: [
          `Perda de sondas (${probeLoss.worstPhase}): ${Math.round(probeLoss.worstLossPct)}%`,
          `Timeouts sob carga: ${probeLoss.loadedTimeouts}`,
          `Ping ocioso medido: ${formatLatency(ping)} ms`
        ],
        meaning:
          'Quando o enfileiramento ou congestionamento descarta ou atrasa pacotes além do tempo limite, aplicações interativas sofrem congelamentos mesmo que os poucos pacotes sobreviventes exibam baixa mediana.',
        probableCauses: [
          'Hipótese principal: esgotamento de fila (tail-drop / bufferbloat severo) no roteador ou enlace durante saturação máxima.',
          'Hipótese alternativa: perda de pacotes em enlace Wi-Fi com interferência ou limitação de sessões no equipamento.'
        ],
        userActions: [
          'Ative gerenciamento inteligente de filas (SQM / QoS) no roteador e repita o teste via cabo Ethernet.'
        ],
        confirmatoryTest:
          'Executar o teste conectado por cabo diretamente ao roteador principal e verificar se a perda de sondas cai para 0%.'
      });
    }

    if (hasHighIdlePing) {
    findings.push({
      code: DIAGNOSIS_CATALOG.HIGH_LATENCY,
      severity: ping > t.idlePingElevatedMax ? 'danger' : 'warning',
      priority: 88,
      title: 'Latência ociosa elevada',
      summary: `Mesmo sem tráfego intenso, o tempo de resposta base registrou ${formatLatency(ping)} ms (acima do patamar ideal de ${t.idlePingGoodMax} ms).`,
      observed: `Mediana de RTT ocioso em ${formatLatency(ping)} ms (mínimo ${formatLatency(stats.unloadedLatency?.min)} ms, P90 ${formatLatency(stats.unloadedLatency?.p90)} ms).`,
      basisMetrics: [
        `Ping ocioso (P50): ${formatLatency(ping)} ms`,
        `Download: ${formatSpeed(dl)} Mbps · Upload: ${formatSpeed(ul)} Mbps`
      ],
      meaning:
        'Aplicações sensíveis ao tempo de resposta (VoIP, acesso remoto SSH/RDP, jogos online e abertura de múltiplas conexões web) terão atraso base perceptível, independentemente da velocidade em Mbps.',
      probableCauses: [
        'Hipótese de roteamento: encaminhamento de tráfego do provedor para um ponto de troca (IX) ou PoP da Cloudflare geograficamente distante.',
        'Hipótese de camada física/acesso: enlace rádio, satélite, rede móvel ou Wi-Fi com retransmissões de quadros.',
        'Hipótese de rede local: tráfego de fundo não interrompido elevando o patamar basal.'
      ],
      userActions: [
        'Reinicie a ONT/modem e o roteador para forçar nova negociação de sessão e verificar se há melhoria de rota.',
        'Teste via cabo Ethernet para descartar atraso introduzido por repetidores ou sinal Wi-Fi fraco.'
      ],
      confirmatoryTest:
        'Executar um traceroute / MTR no sistema operacional para identificar em qual salto (rede local, provedor ou trânsito internacional) a latência se eleva.'
    });
  }

  if (hasHighIdleJitter) {
    findings.push({
      code: DIAGNOSIS_CATALOG.HIGH_JITTER,
      severity: 'warning',
      priority: 84,
      title: 'Jitter elevado (oscilação de latência)',
      summary: `A variação entre pacotes consecutivos em repouso atingiu ${formatLatency(jitter, 1)} ms, indicando irregularidade temporal na entrega.`,
      observed: `Jitter ocioso de ${formatLatency(jitter, 1)} ms com RTT variando entre ${formatLatency(stats.unloadedLatency?.min)} ms e ${formatLatency(stats.unloadedLatency?.max)} ms.`,
      basisMetrics: [
        `Jitter ocioso: ${formatLatency(jitter, 1)} ms`,
        `Dispersão RTT ocioso: ${formatLatency(stats.unloadedLatency?.min)}–${formatLatency(stats.unloadedLatency?.max)} ms`
      ],
      meaning:
        'Mesmo que o ping médio pareça aceitável, picos intermitentes causam picotes de áudio em chamadas, engasgos em streaming ao vivo e rubberbanding em jogos.',
      probableCauses: [
        'Hipótese: interferência eletromagnética, ruído de canal ou contenção CSMA/CA em rede Wi-Fi.',
        'Hipótese: micro-rajadas de tráfego concorrente na rede doméstica ou corporativa.',
        'Hipótese: degradação de sinal óptico/coaxial ou instabilidade no enlace de última milha.'
      ],
      userActions: [
        'Altere o canal Wi-Fi do roteador para um canal menos congestionado ou utilize conexão cabeada.',
        'Verifique cabos de rede mal crimpados ou adaptadores USB/Wi-Fi com economia de energia agressiva.'
      ],
      confirmatoryTest:
        'Comparar uma medição via cabo Ethernet com uma medição via Wi-Fi no mesmo local para confirmar se a oscilação ocorre na camada sem fio.'
    });
  }

  if (hasDownloadInstability) {
    findings.push({
      code: DIAGNOSIS_CATALOG.DOWNLOAD_INSTABILITY,
      severity: 'warning',
      priority: 76,
      title: 'Instabilidade de vazão durante download',
      summary: `Os blocos sustentados de download oscilaram significativamente (mín. ${formatSpeed(sustainedDlStats?.min)} Mbps, mediana ${formatSpeed(dl)} Mbps, média ${formatSpeed(sustainedDlStats?.mean)} Mbps).`,
      observed: `Coeficiente de variação de ${(dlCv * 100).toFixed(0)}% nos blocos de carga sustentada e jitter sob download de ${formatLatency(dlJitter, 1)} ms.`,
      basisMetrics: [
        `Download (${speedMeta.shortLabel}): ${formatSpeed(dl)} Mbps (média sustentada: ${formatSpeed(sustainedDlStats?.mean)} Mbps)`,
        `Jitter sob download: ${formatLatency(dlJitter, 1)} ms`
      ],
      meaning:
        'A velocidade de recepção não se mantém sustentada, podendo causar quedas de qualidade adaptativa em vídeos e tempo irregular em transferências grandes.',
      probableCauses: [
        'Hipótese: variação dinâmica de modulação/taxa em rede Wi-Fi ou rede móvel.',
        'Hipótese: competição por largura de banda com outros clientes na rede local.',
        'Hipótese: gargalo de processamento TCP/TLS no dispositivo cliente ou roteador sob alta taxa de pacotes.'
      ],
      userActions: [
        'Aproxime o dispositivo do roteador ou utilize cabo Ethernet Cat5e/Cat6 para estabilizar a taxa física.',
        'Feche aplicativos que realizam atualizações automáticas ou downloads paralelos.'
      ],
      confirmatoryTest:
        'Executar o teste novamente no mesmo perfil via cabo de rede para verificar se a curva de download torna-se plana e sustentada.'
    });
  }

  if (hasUploadInstability) {
    findings.push({
      code: DIAGNOSIS_CATALOG.UPLOAD_INSTABILITY,
      severity: 'warning',
      priority: 75,
      title: 'Instabilidade no envio (upload) para a internet',
      summary: `A taxa de envio deste dispositivo/rede local para a internet oscilou significativamente entre os blocos (mín. ${formatSpeed(sustainedUlStats?.min)} Mbps, mediana ${formatSpeed(ul)} Mbps, média ${formatSpeed(sustainedUlStats?.mean)} Mbps).`,
      observed: `Coeficiente de variação de ${(ulCv * 100).toFixed(0)}% nos blocos sustentados de upload e jitter sob upload de ${formatLatency(ulJitter, 1)} ms.`,
      basisMetrics: [
        `Upload (${speedMeta.shortLabel}): ${formatSpeed(ul)} Mbps (média sustentada: ${formatSpeed(sustainedUlStats?.mean)} Mbps)`,
        `Jitter sob upload: ${formatLatency(ulJitter, 1)} ms`
      ],
      meaning:
        'Transmissões ao vivo (lives), envio de arquivos grandes e videochamadas com câmera em alta definição podem sofrer quedas de taxa de bits.',
      probableCauses: [
        'Hipótese de dispositivo/rede local: limitação de potência de transmissão do rádio Wi-Fi do aparelho ou atenuação/interferência no caminho de envio até o roteador.',
        'Hipótese local: sincronizações em nuvem ou uploads concorrentes disputando a fila de saída.',
        'Hipótese alternativa (a validar após teste cabeado): controle de rajadas (shaping/policing) ou instabilidade no retorno do enlace.'
      ],
      userActions: [
        'Verifique serviços como OneDrive, Google Drive, iCloud ou backups automáticos ativos no aparelho e na rede local.',
        'Teste próximo ao roteador ou via conexão cabeada antes de acionar o provedor para descartar perda de envio no Wi-Fi do dispositivo.'
      ],
      confirmatoryTest:
        'Realizar um teste isolado via cabo Ethernet e observar se o jitter sob upload permanece abaixo de 15 ms.'
    });
  }

  if (wifiSymptomPattern) {
    const contextNote =
      ctx.linkType === 'wifi-24'
        ? 'Você informou conexão via Wi-Fi 2,4 GHz, faixa naturalmente sujeita a menor largura de canal e maior interferência.'
        : ctx.linkType === 'wifi-5-6'
          ? 'Mesmo em Wi-Fi 5/6 GHz declarado, atenuação por paredes ou distância pode reduzir a taxa negociada.'
          : 'O navegador não identifica diretamente se o enlace é cabo, 2,4 GHz, 5 GHz ou 6 GHz, mas o padrão observado é compatível com limitação de enlace sem fio.';

    findings.push({
      code: DIAGNOSIS_CATALOG.POSSIBLE_WIFI_LIMITATION,
      severity: dl < 60 && ping > 35 ? 'danger' : 'warning',
      priority: 78,
      title: 'Possível limitação do Wi-Fi ou enlace local',
      summary: `O conjunto de download (${formatSpeed(dl)} Mbps), ping (${formatLatency(ping)} ms) e comportamento sob carga sugere possível gargalo na camada local sem fio. ${contextNote}`,
      observed: `Download em ${formatSpeed(dl)} Mbps, upload em ${formatSpeed(ul)} Mbps, ping ocioso de ${formatLatency(ping)} ms e Δ latência máxima de ${formatDeltaMs(maxLoadedDelta)}.`,
      basisMetrics: [
        `Download: ${formatSpeed(dl)} Mbps · Upload: ${formatSpeed(ul)} Mbps`,
        `Ping ocioso: ${formatLatency(ping)} ms · Jitter: ${formatLatency(jitter, 1)} ms`,
        `Contexto informado: ${ctx.linkType}`
      ],
      meaning:
        'A capacidade contratada do provedor pode estar chegando íntegra até o roteador, mas sendo limitada entre o ponto de acesso e o dispositivo.',
      probableCauses: [
        'Hipótese: dispositivo associado à banda de 2,4 GHz (tipicamente limitada entre 40 e 100 Mbps reais em ambientes urbanos) em vez de 5 GHz ou 6 GHz.',
        'Hipótese: distância elevada, obstáculos físicos ou uso de repetidores Wi-Fi que reduzem a taxa efetiva pela metade.',
        'Hipótese alternativa: plano contratado com velocidade inferior a 120 Mbps ou limitação na porta de rede (ex.: link negociado a 100 Mbps Fast Ethernet).'
      ],
      userActions: [
        'Se o roteador disponibilizar SSIDs separados ou band steering, conecte-se à rede 5 GHz ou 6 GHz próximo ao aparelho.',
        'Caso utilize cabo de rede, confira nas propriedades do adaptador se o link negociou a 1,0 Gbps e não a 100 Mbps.'
      ],
      confirmatoryTest:
        'Executar o TestAi a 1 metro do roteador em 5/6 GHz e comparar com um teste via cabo Ethernet Gigabit.'
    });
  }

  if (hasSpeedLimit) {
    const contractedText =
      contractedRatio !== null
        ? ` (${(contractedRatio * 100).toFixed(0)}% dos ${ctx.contractedMbps} Mbps informados)`
        : '';
    const dlAvg = sustainedDlStats?.mean ?? stats.download?.mean ?? dl;
    const onlyUploadLimited =
      ul < t.lowUploadMbps &&
      dl >= t.lowDownloadMbps &&
      (contractedRatio === null || contractedRatio >= t.contractDeliveryRatioMin);

    findings.push({
      code: DIAGNOSIS_CATALOG.LIMITED_SPEED,
      severity: dl < 15 || ul < 3 ? 'danger' : 'warning',
      priority: 80,
      title: onlyUploadLimited
        ? 'Envio (upload) limitado do dispositivo/rede local para a internet'
        : 'Velocidade limitada abaixo do esperado',
      summary: onlyUploadLimited
        ? `O download registrou ${formatSpeed(dl)} Mbps, mas a taxa de envio deste dispositivo/rede local para a internet ficou limitada em ${formatSpeed(ul)} Mbps.`
        : `A vazão medida registrou ${formatSpeed(dl)} Mbps de download${contractedText} e ${formatSpeed(ul)} Mbps de upload.`,
      observed: `Download (${speedMeta.shortLabel}) em ${formatSpeed(dl)} Mbps (média ${formatSpeed(dlAvg)} Mbps) e Upload (${speedMeta.shortLabel}) em ${formatSpeed(ul)} Mbps.`,
      basisMetrics: [
        `Download (${speedMeta.shortLabel}): ${formatSpeed(dl)} Mbps (média ${formatSpeed(dlAvg)} Mbps)`,
        `Upload (${speedMeta.shortLabel}): ${formatSpeed(ul)} Mbps`,
        ...(contractedRatio !== null
          ? [`Relação com plano declarado (${ctx.contractedMbps} Mbps): ${(contractedRatio * 100).toFixed(0)}%`]
          : [])
      ],
      meaning: onlyUploadLimited
        ? 'Embora a recepção esteja adequada, backups em nuvem, envio de arquivos pesados e chamadas de vídeo em alta resolução podem operar com margem reduzida.'
        : 'Downloads de arquivos grandes, backups em nuvem e múltiplas transmissões simultâneas em alta definição operarão com margem reduzida.',
      probableCauses: onlyUploadLimited
        ? [
            'Hipótese de dispositivo/rede local: limitação de transmissão no Wi-Fi do aparelho (ex.: 2,4 GHz, distância ou economia de bateria) ou cabo/porta local degradado.',
            'Hipótese de consumo concorrente: backups automáticos, VPN ou outros dispositivos utilizando o envio da rede local.',
            'Hipótese contratual/enlace (se persistir no cabo): perfil assimétrico do plano contratado ou gargalo de retorno.'
          ]
        : [
            'Hipótese de camada física: cabo de rede limitado a 100 Mbps (Fast Ethernet), adaptador Wi-Fi antigo ou sinal atenuado.',
            'Hipótese de consumo concorrente: outros dispositivos utilizando parte expressiva da banda durante a medição.',
            'Hipótese de provisionamento: perfil de banda aplicado pelo provedor ou congestionamento regional.'
          ],
      userActions: onlyUploadLimited
        ? [
            'Verifique se há VPN, sincronização em nuvem ou economia de bateria limitando o envio do aparelho.',
            'Repita o teste próximo ao roteador em 5/6 GHz ou via cabo Ethernet Gigabit antes de acionar o provedor.'
          ]
        : [
            'Verifique a taxa de negociação física da placa de rede/Wi-Fi no sistema operacional.',
            'Teste diretamente na saída LAN Gigabit da ONT/roteador principal com outros equipamentos desconectados.'
          ],
      confirmatoryTest: onlyUploadLimited
        ? 'Testar via cabo Ethernet diretamente no roteador principal (com uploads em segundo plano pausados) para confirmar se o limite está no aparelho/Wi-Fi ou no perfil da linha.'
        : 'Testar via cabo Cat5e/Cat6 diretamente na porta Gigabit do roteador principal e registrar o laudo técnico caso permaneça abaixo de 80% do contratado.'
    });
  }

  // --------------------------------------------------------------------------
  // 4. SE NENHUMA ANOMALIA FOI DETECTADA -> EXCELENTE OU BOA CONEXÃO
  // --------------------------------------------------------------------------
  if (findings.length === 0) {
    const isExcellent =
      dl >= t.highSpeedDownloadMbps &&
      ul >= 30 &&
      ping <= t.idlePingExcellentMax &&
      (jitter === null || jitter <= t.jitterGoodMax) &&
      maxLoadedDelta <= t.loadedDeltaGoodMax;

    const hasIsolatedSpike =
      loadedSpikes.status === 'isolated' && loadedSpikes.peakMs !== null;
    const isolatedNote = hasIsolatedSpike
      ? `, com pico isolado de ${Math.round(loadedSpikes.peakMs)} ms durante o ${loadedSpikes.peakPhase}`
      : '';

    if (isExcellent) {
      return buildResult({
        code: DIAGNOSIS_CATALOG.EXCELLENT,
        severity: 'good',
        title: 'Excelente desempenho e estabilidade sob carga',
        summary: hasIsolatedSpike
          ? `A conexão entregou ${formatSpeed(dl)} Mbps de download (${speedMeta.shortLabel}) e ${formatSpeed(ul)} Mbps de upload (${speedMeta.shortLabel}) com baixa latência ociosa (${formatLatency(ping)} ms) e variação mediana controlada sob carga (${formatDeltaMs(dlDelta)} ↓ / ${formatDeltaMs(ulDelta)} ↑)${isolatedNote}.`
          : `A conexão entregou ${formatSpeed(dl)} Mbps de download (${speedMeta.shortLabel}) e ${formatSpeed(ul)} Mbps de upload (${speedMeta.shortLabel}) com baixa latência ociosa (${formatLatency(ping)} ms) e mínima variação sob saturação (${formatDeltaMs(dlDelta)} ↓ / ${formatDeltaMs(ulDelta)} ↑).`,
        observed: `Vazão (${speedMeta.diagnosisLabel}: ${formatSpeed(dl)} ↓ / ${formatSpeed(ul)} ↑ Mbps), jitter ocioso de ${formatLatency(jitter, 1)} ms e filas bem controladas durante carga máxima${isolatedNote}.`,
        basisMetrics: [
          `Download (${speedMeta.shortLabel}): ${formatSpeed(dl)} Mbps · Upload (${speedMeta.shortLabel}): ${formatSpeed(ul)} Mbps`,
          `Ping ocioso: ${formatLatency(ping)} ms · Jitter: ${formatLatency(jitter, 1)} ms`,
          `Δ Latência sob carga: ${formatDeltaMs(dlDelta)} (↓) / ${formatDeltaMs(ulDelta)} (↑)`
        ],
        meaning:
          'O enlace apresenta capacidade elevada e excelente controle de fila, suportando simultaneamente streaming 4K, videochamadas críticas, backups e jogos competitivos sem degradação.',
        probableCauses: [
          'Enlace óptico/banda larga bem dimensionado combinado com rede local saudável (Ethernet Gigabit+ ou Wi-Fi 5/6 GHz com bom sinal).',
          'Ausência de enfileiramento excessivo (bufferbloat) perceptível até a borda medida.'
        ],
        userActions: [
          'Nenhuma intervenção corretiva necessária. Salve este resultado no histórico como linha de base (baseline) da sua rede.'
        ],
        confirmatoryTest:
          'Opcional: repetir a medição em horário de pico noturno (20h–23h) para confirmar se o provedor mantém a mesma estabilidade.',
        secondaryFindings: [],
        loadedSpikes
      });
    }

    return buildResult({
      code: DIAGNOSIS_CATALOG.GOOD,
      severity: 'good',
      title: 'Boa conexão dentro dos parâmetros esperados',
      summary: `Desempenho equilibrado com ${formatSpeed(dl)} Mbps de download (${speedMeta.shortLabel}), ${formatSpeed(ul)} Mbps de upload (${speedMeta.shortLabel}), ping ocioso de ${formatLatency(ping)} ms e variação controlada sob carga${isolatedNote}.`,
      observed: `Métricas de vazão (${speedMeta.diagnosisLabel}), latência ociosa (${formatLatency(ping)} ms) e latência carregada (${formatLatency(dlLat)} ms ↓ / ${formatLatency(ulLat)} ms ↑) dentro de faixas saudáveis${isolatedNote}.`,
      basisMetrics: [
        `Download (${speedMeta.shortLabel}): ${formatSpeed(dl)} Mbps · Upload (${speedMeta.shortLabel}): ${formatSpeed(ul)} Mbps`,
        `Ping ocioso: ${formatLatency(ping)} ms · Jitter: ${formatLatency(jitter, 1)} ms`,
        `Δ Latência sob carga: ${formatDeltaMs(dlDelta)} (↓) / ${formatDeltaMs(ulDelta)} (↑)`
      ],
      meaning:
        'A conexão atende com folga navegação, trabalho remoto, reuniões em vídeo, streaming em alta definição e jogos online.',
      probableCauses: [
        'Operação regular do enlace de acesso e da rede local, compatível com o perfil da conexão.'
      ],
      userActions: [
        'Mantenha o firmware do roteador atualizado e prefira conexão cabeada em estações fixas quando buscar latência mínima.'
      ],
      confirmatoryTest:
        'Executar o perfil Alta Capacidade caso possua plano igual ou superior a 1 Gbps para validar saturação máxima.',
      secondaryFindings: [],
      loadedSpikes
    });
  }

  findings.sort((a, b) => b.priority - a.priority);
  const primary = findings[0];
  const secondaryFindings = findings.slice(1).map((item) => ({
    code: item.code,
    severity: item.severity,
    title: item.title,
    summary: item.summary
  }));

  return buildResult({
    ...primary,
    secondaryFindings,
    loadedSpikes
  });
}

function buildResult(payload) {
  return {
    code: payload.code,
    severity: payload.severity,
    title: payload.title,
    summary: payload.summary,
    observed: payload.observed,
    basisMetrics: payload.basisMetrics || [],
    meaning: payload.meaning,
    probableCauses: payload.probableCauses || [],
    userActions: payload.userActions || [],
    confirmatoryTest: payload.confirmatoryTest,
    secondaryFindings: payload.secondaryFindings || [],
    ...(payload.loadedSpikes ? { loadedSpikes: payload.loadedSpikes } : {})
  };
}