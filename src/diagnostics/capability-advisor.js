/**
 * Motor de tradução prática da telemetria em cenários reais de uso
 * e análise comparativa entre especificações do aparelho e resultados medidos.
 */

import { isNonNegativeNumber, METRIC_STATUS } from '../utils/validators.js';
import { formatLatency, formatSpeed } from '../utils/formatters.js';
import { analyzeLoadedLatencySpikes } from './connection-diagnostics.js';
import {
  evaluateLoadedLatencySpikes,
  evaluateProbeLoss,
  STABILITY_RULES
} from './stability-rules.js';

export function normalizeSpecText(text) {
  return String(text ?? '')
    .replace(/&nbsp;|&#0*160;|&#x0*a0;|\u00a0/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Retorna marcos contextuais discretos durante a medição ativa,
 * ancorados na interface sem sobrepor botões ou gráficos.
 */
export function getLiveCapabilityMilestone(currentMbps, phase) {
  const speed = Math.max(0, Number(currentMbps) || 0);

  if (phase === 'latency') {
    return 'Verificando tempo de resposta inicial da rede...';
  }
  if (phase === 'upload') {
    if (speed >= 150) {
      return 'Upload elevado: envio rápido de vídeos pesados, lives 4K e backups em nuvem.';
    }
    if (speed >= 30) {
      return 'Bom upload para videochamadas em alta definição e envio de arquivos.';
    }
    return 'Medindo capacidade de envio (upload) para chamadas e nuvem...';
  }

  if (speed >= 500) {
    return 'Faixa Gigabit: downloads pesados, múltiplos streams 4K e casa conectada com folga.';
  }
  if (speed >= 250) {
    return 'Acima de 250 Mbps: filmes em 4K, jogos baixados rapidamente e vários aparelhos ativos.';
  }
  if (speed >= 80) {
    return 'Acima de 80 Mbps: streaming 4K, reuniões por vídeo e navegação fluida.';
  }
  if (speed >= 25) {
    return 'Acima de 25 Mbps: streaming Full HD/4K leve e chamadas de vídeo estáveis.';
  }
  return 'Aferindo vazão inicial de download...';
}

/**
 * Avalia 4 cenários práticos cruzando vazão (Download/Upload) com latência,
 * jitter e variação sob carga (bufferbloat).
 * @param {import('../types.js').SpeedTestResult} result
 * @returns {import('../types.js').CapabilityCard[]}
 */
export function evaluatePracticalCapabilities(result) {
  const m = /** @type {Partial<import('../types.js').SpeedTestMetrics>} */ (
    result?.metrics || {}
  );
  const dl = m.download?.status === METRIC_STATUS.MEASURED ? m.download.value : null;
  const ul = m.upload?.status === METRIC_STATUS.MEASURED ? m.upload.value : null;
  const ping = m.ping?.status === METRIC_STATUS.MEASURED ? m.ping.value : null;
  const jitter = m.jitter?.status === METRIC_STATUS.MEASURED ? m.jitter.value : null;
  const dlDelta =
    m.downloadLatencyDelta?.status === METRIC_STATUS.MEASURED
      ? m.downloadLatencyDelta.value
      : null;
  const ulDelta =
    m.uploadLatencyDelta?.status === METRIC_STATUS.MEASURED
      ? m.uploadLatencyDelta.value
      : null;

  if (!isNonNegativeNumber(dl) || !isNonNegativeNumber(ul) || !isNonNegativeNumber(ping)) {
    return [];
  }

  const maxLoadedDelta = Math.max(dlDelta ?? 0, ulDelta ?? 0);
  const severeBufferbloat = maxLoadedDelta >= 60;
  const moderateBufferbloat = maxLoadedDelta >= 30 && maxLoadedDelta < 60;
  const elevatedJitter = isNonNegativeNumber(jitter) && jitter > 15;

  // 1. Streaming e Entretenimento
  let streamingStatus = 'Excelente';
  /** @type {import('../types.js').SemanticTone} */
  let streamingTone = 'good';
  let streamingText =
    'Suporta múltiplos filmes e séries em 4K HDR simultaneamente sem engasgos de carregamento.';

  if (dl < 15) {
    streamingStatus = 'Limitado';
    streamingTone = 'danger';
    streamingText =
      'Adequado para vídeos em HD (720p/1080p) em uma tela; conteúdos em 4K podem exigir buffering.';
  } else if (dl < 50) {
    streamingStatus = 'Bom para 4K';
    streamingTone = 'good';
    streamingText =
      'Permite assistir a filmes e séries em 4K em até 1–2 telas sem perda de resolução.';
  } else if (dl < 150) {
    streamingStatus = 'Muito Bom';
    streamingTone = 'good';
    streamingText =
      'Roda streaming 4K com folga em várias TVs e celulares ao mesmo tempo.';
  }

  // 2. Downloads e Arquivos Grandes
  let downloadsStatus = 'Excelente';
  /** @type {import('../types.js').SemanticTone} */
  let downloadsTone = 'good';
  let downloadsText = `Com ${formatSpeed(dl)} Mbps, jogos de 50 GB levam cerca de ${estimateDownloadMinutes(dl, 50)} em condições ideais.`;

  if (dl < 25) {
    downloadsStatus = 'Lento para arquivos grandes';
    downloadsTone = 'warning';
    downloadsText =
      'Downloads leves funcionam bem, mas jogos e atualizações pesadas exigirão mais tempo.';
  } else if (dl < 120) {
    downloadsStatus = 'Bom ritmo';
    downloadsTone = 'good';
    downloadsText = `Boa velocidade para atualizações, backups e jogos médios (~${estimateDownloadMinutes(dl, 20)} para 20 GB).`;
  }

  // 3. Jogos Online e Videochamadas (depende fortemente de latência e estabilidade sob carga)
  let realtimeStatus = 'Estável e Responsivo';
  /** @type {import('../types.js').SemanticTone} */
  let realtimeTone = 'good';
  let realtimeText = `Ping ocioso baixo (${formatLatency(ping)} ms) e resposta firme mesmo com a rede em uso (${formatLatency(maxLoadedDelta)} ms de variação sob carga).`;

  if (ping > 75 || severeBufferbloat || elevatedJitter) {
    realtimeStatus = 'Sensível sob uso intenso';
    realtimeTone = severeBufferbloat || ping > 90 ? 'danger' : 'warning';
    if (severeBufferbloat && dl >= 100) {
      realtimeText = `Apesar dos ${formatSpeed(dl)} Mbps de banda, a latência sobe +${formatLatency(maxLoadedDelta)} ms sob carga — jogos e chamadas podem oscilar se alguém estiver baixando arquivos pesados.`;
    } else if (ping > 75) {
      realtimeText = `Tempo de resposta base elevado (${formatLatency(ping)} ms); partidas competitivas podem ter atraso perceptível.`;
    } else {
      realtimeText = `Oscilação de jitter (${formatLatency(jitter, 1)} ms) pode causar micro-cortes em chamadas de voz/vídeo.`;
    }
  } else if (ping > 40 || moderateBufferbloat || ul < 10) {
    realtimeStatus = 'Bom com ressalvas';
    realtimeTone = 'warning';
    realtimeText =
      ul < 10
        ? `Ping aceitável (${formatLatency(ping)} ms), mas a taxa de envio deste dispositivo/rede local para a internet (${formatSpeed(ul)} Mbps de upload) limita câmeras em alta resolução.`
        : `Funciona bem no dia a dia, mas downloads pesados simultâneos adicionam +${formatLatency(maxLoadedDelta)} ms de atraso.`;
  }

  // 4. Casa Conectada / Multi-dispositivos
  let homeStatus = 'Alta Capacidade';
  /** @type {import('../types.js').SemanticTone} */
  let homeTone = 'good';
  let homeText =
    'Suporta trabalho remoto, câmeras Wi-Fi, TVs 4K e vários smartphones conectados ao mesmo tempo.';

  if (dl >= 40 && ul < 8) {
    homeStatus = 'Envio (Upload) Limitado';
    homeTone = 'warning';
    homeText = `O download atende bem, mas o envio deste dispositivo/rede local para a internet (${formatSpeed(ul)} Mbps de upload) está reduzido e pode limitar backups e chamadas simultâneas.`;
  } else if (dl < 40 || ul < 8) {
    homeStatus = 'Uso Moderado';
    homeTone = 'warning';
    homeText =
      'Atende bem poucos aparelhos simultâneos; múltiplos downloads ou envios simultâneos para a internet podem disputar banda.';
  } else if (severeBufferbloat) {
    homeStatus = 'Boa banda, fila sensível';
    homeTone = 'warning';
    homeText =
      'Há banda suficiente para vários aparelhos, mas o roteador tende a atrasar pacotes interativos quando a rede lota.';
  }

  return [
    {
      id: 'streaming',
      title: 'Streaming & Vídeo',
      status: streamingStatus,
      tone: streamingTone,
      description: streamingText
    },
    {
      id: 'downloads',
      title: 'Downloads & Arquivos',
      status: downloadsStatus,
      tone: downloadsTone,
      description: downloadsText
    },
    {
      id: 'realtime',
      title: 'Jogos & Chamadas',
      status: realtimeStatus,
      tone: realtimeTone,
      description: realtimeText
    },
    {
      id: 'multi-device',
      title: 'Casa Conectada',
      status: homeStatus,
      tone: homeTone,
      description: homeText
    }
  ];
}

function estimateDownloadMinutes(mbps, sizeGigabytes) {
  if (!Number.isFinite(mbps) || mbps <= 0) return '—';
  // Considera eficiência típica de protocolo (~85% da vazão útil)
  const effectiveMBps = (mbps * 0.85) / 8;
  const totalSeconds = (sizeGigabytes * 1024) / effectiveMBps;
  if (totalSeconds < 60) {
    return `${Math.max(1, Math.round(totalSeconds))} seg`;
  }
  const mins = Math.round(totalSeconds / 60);
  if (mins < 60) {
    return `${mins} min`;
  }
  const hours = (mins / 60).toFixed(1);
  return `${hours} h`;
}

/**
 * Classifica a categoria de desempenho do smartphone (Básico / Médio / Alto Desempenho)
 * baseando-se em:
 * 1) Geração de Wi-Fi e tecnologias de conectividade (5G, Wi-Fi 6E, Wi-Fi 7)
 * 2) Hardware (chipset/SoC) quando retornado pela fonte
 * 3) Família comercial do modelo e fabricante
 */
export function deriveDeviceCategory(device) {
  if (!device) {
    return {
      tier: 'Não identificado',
      shortLabel: 'Não identificado',
      badge: 'NÃO IDENTIFICADO',
      tone: 'neutral',
      summary: 'Dispositivo não informado.'
    };
  }

  const mfg = String(device.manufacturer || '').toLowerCase();
  const model = String(device.model || '').toLowerCase();
  const full = `${mfg} ${model}`;
  const chipset = String(device.hardware?.chipset || '').toLowerCase();
  const wifiGen = String(device.wifi?.generation || '');
  const has5G = Boolean(device.cellular?.has5G);
  const supports6Ghz = Boolean(device.wifi?.supports6Ghz);

  const isEntryName =
    /\b(galaxy\s*a0\d[a-z]?|galaxy\s*a1\d[a-z]?|galaxy\s*m0\d[a-z]?|galaxy\s*m1\d[a-z]?|galaxy\s*j\d[a-z]?|galaxy\s*f0\d[a-z]?|galaxy\s*f1\d[a-z]?|galaxy\s*core|galaxy\s*pocket|galaxy\s*young|moto\s*e\d*[a-z]?|moto\s*g0\d[a-z]?|moto\s*g1\d[a-z]?|redmi\s*a\d+[a-z]?|redmi\s*c\d*|redmi\s*\d+[ac]\b|poco\s*c\d+[a-z]?|twist|positivo|multilaser|philco)\b/i.test(
      full
    );

  const isMidName =
    /\b(galaxy\s*a[2-7]\d[a-z]?|galaxy\s*m[2-6]\d[a-z]?|galaxy\s*f[2-6]\d[a-z]?|moto\s*g[2-9]\d[a-z]?|moto\s*g\s*(?:power|stylus|play|5g)|redmi\s*note\b|poco\s*[mx]\d+[a-z]?|pixel\s*\d+a\b)\b/i.test(
      full
    );

  const isFlagshipName =
    /\b(iphone\s*(?:1[1-9]|2\d|x[rs])\b|iphone\b.*\b(?:pro|max|plus|air)\b|galaxy\s*s(?:1\d|2\d|3\d)[a-z]?|galaxy\s*z\s*(?:fold|flip)|galaxy\s*note\s*(?:10|20)\b|pixel\s*(?:[6-9]|1\d)(?!a\b)|edge\s*(?:\d{2}|plus|ultra|pro)|razr|rog\s*phone|zenfone|oneplus\s*(?:[7-9]|1\d)|xiaomi\s*1[1-9]|poco\s*f\d+)\b/i.test(
      full
    ) || /\bedge\+(?!\w)/i.test(full);

  const isFlagshipChipset =
    /\b(apple\s*a1[3-9]|a1[3-9]\s*(?:bionic|pro)|snapdragon\s*8\s*(?:gen|s\s*gen|elite)|snapdragon\s*8[5-9]\d|sm8[2-8]\d\d|dimensity\s*(?:8[2-9]\d\d|9\d{3})|exynos\s*2[1-9]\d\d|google\s*tensor|tensor\s*g\d)\b/i.test(
      chipset
    );

  const isEntryChipset =
    /\b(unisoc\s*(?:sc|t3\d\d|t60\d|t61[0-2])|helio\s*(?:a\d+|p2\d|p3\d|g2\d|g3\d|g8[015])|mt67[36]\d|exynos\s*(?:788[45]|850)|snapdragon\s*(?:2\d\d|4[1-6]\d))\b/i.test(
      chipset
    );

  const isUltraWifi = wifiGen === 'Wi-Fi 7' || wifiGen === 'Wi-Fi 6E' || supports6Ghz;
  const isHighWifi = isUltraWifi || wifiGen === 'Wi-Fi 6';
  const isLegacyWifi = wifiGen === 'Wi-Fi 4' || wifiGen === 'Wi-Fi 3 (802.11b/g)';

  // 1. ALTO DESEMPENHO (Topo de Linha / Flagship)
  if (
    isFlagshipName ||
    isUltraWifi ||
    isFlagshipChipset ||
    (isHighWifi && has5G && !isEntryName && !isMidName)
  ) {
    return {
      tier: 'Alto Desempenho (Topo de Linha)',
      shortLabel: 'Alto Desempenho',
      badge: 'ALTO DESEMPENHO',
      tone: 'good',
      summary:
        'Hardware topo de linha com máxima capacidade de conectividade, ideal para jogos competitivos, downloads pesados e transmissões sem gargalo.'
    };
  }

  // 2. BÁSICO (Entrada)
  if (
    isEntryName ||
    (isLegacyWifi && !has5G) ||
    (isEntryChipset && !isMidName && !has5G && !isHighWifi)
  ) {
    return {
      tier: 'Básico (Entrada)',
      shortLabel: 'Básico',
      badge: 'BÁSICO / ENTRADA',
      tone: 'warning',
      summary:
        'Aparelho de entrada focado em tarefas essenciais (redes sociais, vídeos e mensagens). Possui rádio Wi-Fi econômico com teto de velocidade limitado.'
    };
  }

  // 3. MÉDIO (Intermediário)
  return {
    tier: 'Médio (Intermediário)',
    shortLabel: 'Médio',
    badge: 'INTERMEDIÁRIO / MÉDIO',
    tone: 'info',
    summary:
      'Aparelho intermediário com bom equilíbrio entre velocidade e alcance, suportando vídeos em alta resolução e multitarefa estável.'
  };
}

/**
 * Deriva as médias reais esperadas em Mbps para cada banda Wi-Fi (2,4 GHz, 5 GHz e 6 GHz),
 * eliminando termos vagos e informando diretamente o que o celular alcança na prática.
 */
export function deriveWifiBandAverages(device) {
  const wifi = device?.wifi || {};
  const wifiGen = String(wifi.generation || '');
  const bands = Array.isArray(wifi.bands) ? wifi.bands : [];
  const category = deriveDeviceCategory(device);
  const hasKnownWifiGen = Boolean(wifiGen && !/não disponível/i.test(wifiGen));

  const supports6Ghz =
    Boolean(wifi.supports6Ghz) ||
    wifiGen === 'Wi-Fi 6E' ||
    wifiGen === 'Wi-Fi 7' ||
    bands.includes('6 GHz');

  // Determina suporte a 5 GHz:
  // Se declarado em bands ou geração Wi-Fi 5/6/6E/7.
  // Se desconhecido (fonte sem campo de WLAN), inferimos pela categoria:
  // Se Básico tipo Galaxy A10/Moto E22 -> apenas 2,4 GHz.
  // Se Intermediário/Topo -> dual-band 5 GHz.
  let supports5Ghz = false;
  if (bands.includes('5 GHz') || ['Wi-Fi 5', 'Wi-Fi 6', 'Wi-Fi 6E', 'Wi-Fi 7'].includes(wifiGen)) {
    supports5Ghz = true;
  } else if (!hasKnownWifiGen) {
    supports5Ghz = category.tier !== 'Básico (Entrada)';
  }

  // Identifica padrão efetivo (real ou inferido por categoria quando ausente)
  let effectiveGen = wifiGen;
  if (!hasKnownWifiGen) {
    if (category.tier === 'Alto Desempenho (Topo de Linha)') {
      effectiveGen = 'Wi-Fi 6';
    } else if (category.tier === 'Básico (Entrada)') {
      effectiveGen = 'Wi-Fi 4';
    } else {
      effectiveGen = 'Wi-Fi 5';
    }
  }

  // 1. Banda 2,4 GHz (suportada por praticamente todos os smartphones)
  const band24 = {
    label: 'Wi-Fi 2,4 GHz',
    supported: true,
    status: 'Suportado',
    speedRange: '35 a 70 Mbps',
    typicalSpeed: '~50 Mbps',
    note: 'Faixa com maior alcance e paredes, mas limitada por interferência.'
  };

  if (effectiveGen === 'Wi-Fi 7') {
    band24.speedRange = '70 a 140 Mbps';
    band24.typicalSpeed = '~100 Mbps';
  } else if (effectiveGen === 'Wi-Fi 6' || effectiveGen === 'Wi-Fi 6E') {
    band24.speedRange = '60 a 120 Mbps';
    band24.typicalSpeed = '~85 Mbps';
  } else if (effectiveGen === 'Wi-Fi 5') {
    band24.speedRange = '45 a 85 Mbps';
    band24.typicalSpeed = '~65 Mbps';
  } else if (effectiveGen === 'Wi-Fi 3 (802.11b/g)') {
    band24.speedRange = '15 a 25 Mbps';
    band24.typicalSpeed = '~20 Mbps';
  }

  // 2. Banda 5 GHz
  const band5 = {
    label: 'Wi-Fi 5 GHz',
    supported: false,
    status: 'Não suportado',
    speedRange: 'Não suportado (apenas 2,4 GHz)',
    typicalSpeed: null,
    note: 'Este celular opera apenas em 2,4 GHz e não detecta redes Wi-Fi 5 GHz.'
  };

  if (supports5Ghz) {
    band5.supported = true;
    band5.status = 'Suportado';
    band5.note = 'Maior velocidade e menor interferência próximo ao roteador.';

    if (effectiveGen === 'Wi-Fi 7') {
      band5.speedRange = '700 a 1.200 Mbps';
      band5.typicalSpeed = '~900 Mbps';
    } else if (effectiveGen === 'Wi-Fi 6' || effectiveGen === 'Wi-Fi 6E') {
      band5.speedRange = '500 a 900 Mbps';
      band5.typicalSpeed = '~650 Mbps';
    } else if (effectiveGen === 'Wi-Fi 5') {
      band5.speedRange = '220 a 450 Mbps';
      band5.typicalSpeed = '~320 Mbps';
    } else {
      band5.speedRange = '60 a 100 Mbps';
      band5.typicalSpeed = '~80 Mbps';
    }
  }

  // 3. Banda 6 GHz (Wi-Fi 6E / Wi-Fi 7)
  const band6 = {
    label: 'Wi-Fi 6 GHz (6E / 7)',
    supported: false,
    status: 'Não suportado',
    speedRange: 'Não suportado',
    typicalSpeed: null,
    note: 'Sem suporte à faixa de 6 GHz (exclusiva de aparelhos Wi-Fi 6E ou Wi-Fi 7).'
  };

  if (supports6Ghz) {
    band6.supported = true;
    band6.status = effectiveGen === 'Wi-Fi 7' ? 'Suportado (Wi-Fi 7)' : 'Suportado (Wi-Fi 6E)';
    band6.note = 'Banda ultra-rápida sem interferências para roteadores Wi-Fi 6E ou 7.';

    if (effectiveGen === 'Wi-Fi 7') {
      band6.speedRange = '1.200 a 2.400+ Mbps';
      band6.typicalSpeed = '~1.600 Mbps';
    } else {
      band6.speedRange = '800 a 1.400 Mbps';
      band6.typicalSpeed = '~1.100 Mbps';
    }
  }

  return {
    band24,
    band5,
    band6,
    effectiveGen,
    isInferredFromCategory: !hasKnownWifiGen
  };
}

/**
 * Resume a estabilidade prática da conexão para o Modo Simples,
 * evitando exibir "Excelente" quando o teste foi parcial ou inconclusivo.
 * @param {import('../types.js').SpeedTestResult} result
 * @param {boolean} [isPartial]
 * @returns {{ label: string, sub: string, tone: import('../types.js').SemanticTone }}
 */
export function evaluateSimpleStability(result, isPartial = false) {
  const m = /** @type {Partial<import('../types.js').SpeedTestMetrics>} */ (
    result?.metrics || {}
  );
  const hasDlDelta =
    m.downloadLatencyDelta?.status === METRIC_STATUS.MEASURED &&
    isNonNegativeNumber(m.downloadLatencyDelta.value);
  const hasUlDelta =
    m.uploadLatencyDelta?.status === METRIC_STATUS.MEASURED &&
    isNonNegativeNumber(m.uploadLatencyDelta.value);
  const hasJitter =
    m.jitter?.status === METRIC_STATUS.MEASURED && isNonNegativeNumber(m.jitter.value);
  const hasPing =
    m.ping?.status === METRIC_STATUS.MEASURED && isNonNegativeNumber(m.ping.value);

  const missingCore = Boolean(
    isPartial ||
      result?.incomplete === true ||
      m.download?.status !== METRIC_STATUS.MEASURED ||
      m.upload?.status !== METRIC_STATUS.MEASURED ||
      m.ping?.status !== METRIC_STATUS.MEASURED
  );

  if (missingCore) {
    return {
      label: 'Inconclusiva',
      sub: 'Medição parcial',
      tone: 'warning'
    };
  }

  const ping = hasPing ? m.ping.value : 0;
  const jitter = hasJitter ? m.jitter.value : 0;
  const probeLoss = evaluateProbeLoss(result);

  if (probeLoss.isSevereLoss) {
    return {
      label: 'Sensível',
      sub: `Perda de ${Math.round(probeLoss.worstLossPct)}% nas sondas (${probeLoss.worstPhase})`,
      tone: 'danger'
    };
  }

  if (!hasDlDelta && !hasUlDelta) {
    if (jitter > STABILITY_RULES.idleJitterSensitiveMinMs) {
      return {
        label: 'Sensível',
        sub: `Jitter elevado (${Math.round(jitter)} ms)`,
        tone: 'danger'
      };
    }
    if (probeLoss.isModerateLoss) {
      return {
        label: 'Moderada',
        sub:
          probeLoss.worstLossPct >= STABILITY_RULES.moderateLossPctMin
            ? `Perda de ${Math.round(probeLoss.worstLossPct)}% nas sondas (${probeLoss.worstPhase})`
            : `${probeLoss.loadedTimeouts} timeouts sob carga (${probeLoss.worstPhase})`,
        tone: 'warning'
      };
    }
    if (ping > STABILITY_RULES.idlePingModerateStabilityMinMs) {
      return {
        label: 'Moderada',
        sub: `Ping alto em repouso (${Math.round(ping)} ms)`,
        tone: 'warning'
      };
    }
    return {
      label: 'Parcial',
      sub: hasJitter ? `Jitter ${m.jitter.value.toFixed(1)} ms` : 'Sem dados sob carga',
      tone: 'info'
    };
  }

  const maxDelta = Math.max(
    hasDlDelta ? m.downloadLatencyDelta.value : 0,
    hasUlDelta ? m.uploadLatencyDelta.value : 0
  );

  if (maxDelta >= STABILITY_RULES.loadedDeltaSevereMinMs) {
    return {
      label: 'Sensível',
      sub: `+${Math.round(maxDelta)} ms sob carga`,
      tone: 'danger'
    };
  }

  if (jitter > STABILITY_RULES.idleJitterSensitiveMinMs) {
    return {
      label: 'Sensível',
      sub: `Jitter elevado (${Math.round(jitter)} ms)`,
      tone: 'danger'
    };
  }

  if (ping > STABILITY_RULES.idlePingCriticalStabilityMinMs) {
    return {
      label: 'Sensível',
      sub: `Ping crítico em repouso (${Math.round(ping)} ms)`,
      tone: 'danger'
    };
  }

  if (probeLoss.isModerateLoss) {
    return {
      label: 'Moderada',
      sub:
        probeLoss.worstLossPct >= STABILITY_RULES.moderateLossPctMin
          ? `Perda de ${Math.round(probeLoss.worstLossPct)}% nas sondas (${probeLoss.worstPhase})`
          : `${probeLoss.loadedTimeouts} timeouts sob carga (${probeLoss.worstPhase})`,
      tone: 'warning'
    };
  }

  const rawSpikes = result?.loadedSpikes || analyzeLoadedLatencySpikes(result);
  const loadedSpikes =
    typeof rawSpikes?.hasSevereSpike === 'boolean'
      ? rawSpikes
      : evaluateLoadedLatencySpikes(result);

  if (loadedSpikes.status === 'recurrent' && loadedSpikes.peakMs !== null) {
    return {
      label: 'Moderada',
      sub: `Picos até ${Math.round(loadedSpikes.peakMs)} ms (${loadedSpikes.peakPhase})`,
      tone: 'warning'
    };
  }

  if (loadedSpikes.hasSevereSpike && loadedSpikes.peakMs !== null) {
    return {
      label: 'Moderada',
      sub: `Pico severo de ${Math.round(loadedSpikes.peakMs)} ms (${loadedSpikes.peakPhase})`,
      tone: 'warning'
    };
  }

  if (maxDelta >= STABILITY_RULES.loadedDeltaModerateMinMs) {
    return {
      label: 'Moderada',
      sub: `+${Math.round(maxDelta)} ms sob carga`,
      tone: 'warning'
    };
  }

  if (jitter > STABILITY_RULES.idleJitterGoodMaxMs) {
    return {
      label: 'Moderada',
      sub: `Jitter moderado (${jitter.toFixed(1)} ms)`,
      tone: 'warning'
    };
  }

  if (ping > STABILITY_RULES.idlePingModerateStabilityMinMs) {
    return {
      label: 'Moderada',
      sub: `Ping alto em repouso (${Math.round(ping)} ms)`,
      tone: 'warning'
    };
  }

  if (loadedSpikes.status === 'isolated' && loadedSpikes.peakMs !== null) {
    return {
      label: 'Excelente',
      sub: `Pico isolado ${Math.round(loadedSpikes.peakMs)} ms (${loadedSpikes.peakPhase})`,
      tone: 'good'
    };
  }

  return {
    label: 'Excelente',
    sub: `Variação +${Math.round(maxDelta)} ms`,
    tone: 'good'
  };
}

/**
 * Compara a capacidade documentada do aparelho com a velocidade medida no TestAi,
 * distinguindo explicitamente:
 * 1) Especificação teórica documentada
 * 2) Estimativa em condições favoráveis
 * 3) Velocidade efetivamente medida
 * @param {import('../types.js').DeviceSpec} device
 * @param {import('../types.js').SpeedTestResult | null} [result]
 */
export function evaluateDeviceComparison(device, result) {
  if (!device) return null;

  const m = /** @type {Partial<import('../types.js').SpeedTestMetrics>} */ (
    result?.metrics || {}
  );
  const measuredDl =
    m.download?.status === METRIC_STATUS.MEASURED ? m.download.value : null;
  const measuredUl =
    m.upload?.status === METRIC_STATUS.MEASURED ? m.upload.value : null;
  const ctxLink = result?.context?.linkType || 'nao-informado';

  const category = deriveDeviceCategory(device);
  const wifiBandAverages = deriveWifiBandAverages(device);
  const wifi = device.wifi || {};
  const cell = device.cellular || {};

  const hasKnownWifiGen = Boolean(
    wifi.generation && !/não disponível/i.test(wifi.generation)
  );
  const hasKnownStandards = Boolean(
    wifi.standards && !/não disponível/i.test(wifi.standards)
  );
  const displayWifiGen = hasKnownWifiGen ? wifi.generation : wifiBandAverages.effectiveGen;

  const theoreticalText = isNonNegativeNumber(wifi.theoreticalLinkMbps)
    ? `Enlace PHY Wi-Fi até ${wifi.theoreticalLinkMbps} Mbps (${displayWifiGen}${wifi.mimo ? `, ${wifi.mimo}` : ''})`
    : hasKnownWifiGen
      ? `${displayWifiGen}${hasKnownStandards ? ` (${wifi.standards})` : ' (especificação da ficha técnica)'}`
      : `${displayWifiGen} (estimado pela categoria ${category.shortLabel})`;

  const favorableText = wifi.favorableRangeMbps
    ? `${wifi.favorableRangeMbps} em condições favoráveis próximo ao roteador`
    : wifiBandAverages.band6.supported
      ? `${wifiBandAverages.band6.speedRange} na faixa de 6 GHz`
      : wifiBandAverages.band5.supported
        ? `${wifiBandAverages.band5.speedRange} na faixa de 5 GHz`
        : `${wifiBandAverages.band24.speedRange} na faixa de 2,4 GHz`;

  const compatibilitySummary = `${displayWifiGen} · ${wifiBandAverages.band5.supported ? 'Dual-band (2,4 GHz e 5 GHz)' : 'Apenas 2,4 GHz'}${wifiBandAverages.band6.supported ? ' + Faixa 6 GHz' : ''}${cell.has5G ? ' · Rede 5G' : cell.has4G ? ' · Rede 4G LTE' : ''}`;

  const hardwareSummary =
    [device.hardware?.chipset, device.hardware?.ram]
      .map(normalizeSpecText)
      .filter(Boolean)
      .join(' · ') || null;

  const channelLabel =
    Array.isArray(wifi.channelWidthsMhz) && wifi.channelWidthsMhz.length > 0
      ? `${wifi.channelWidthsMhz.join(' / ')} MHz`
      : 'Automático';

  const mobileBandsSummary =
    Array.isArray(cell.bands5G) && cell.bands5G.length > 0
      ? `5G: ${cell.bands5G.slice(0, 6).join(', ')}`
      : Array.isArray(cell.bands4G) && cell.bands4G.length > 0
        ? `4G LTE: ${cell.bands4G.slice(0, 6).join(', ')}`
        : cell.has5G
          ? 'Compatível com 5G'
          : 'Compatível com 4G LTE';

  const sixGhzNote = wifiBandAverages.band6.supported
    ? 'Compatível com Wi-Fi de 6 GHz (Wi-Fi 6E/7).'
    : 'Sem suporte a Wi-Fi de 6 GHz.';

  if (!isNonNegativeNumber(measuredDl)) {
    return {
      deviceName: `${device.manufacturer} ${device.model}`,
      regionalVariant: device.regionalVariant,
      category,
      wifiBandAverages,
      compatibilitySummary,
      hardwareSummary,
      channelWidthsLabel: channelLabel,
      mobileBandsSummary,
      sixGhzNote,
      tiers: {
        theoretical: theoreticalText,
        favorableEstimate: favorableText,
        measured: 'Aguardando execução do teste'
      },
      verdictBadge: 'PRONTO PARA COMPARAR',
      verdictTone: 'neutral',
      analysis: `Modelo ${device.manufacturer} ${device.model} identificado como ${category.tier}. Execute o teste para cruzar a velocidade medida neste navegador com a capacidade do smartphone.`,
      source: device.source,
      dataVersion: device.dataVersion
    };
  }

  const measuredSummary = isNonNegativeNumber(measuredUl)
    ? `${formatSpeed(measuredDl)} Mbps ↓ / ${formatSpeed(measuredUl)} Mbps ↑`
    : `${formatSpeed(measuredDl)} Mbps ↓ (envio para a internet indisponível)`;

  // Análise inteligente cruzando medição com hardware do aparelho
  let verdictBadge = 'COMPATÍVEL COM A REDE';
  let verdictTone = 'good';
  let analysis = '';

  const isEntryOnly24 = !wifiBandAverages.band5.supported;

  if (isEntryOnly24 && measuredDl >= 35) {
    verdictBadge = 'PRÓXIMO AO LIMITE DO APARELHO (2,4 GHz)';
    verdictTone = 'warning';
    analysis = `Você mediu ${formatSpeed(measuredDl)} Mbps. Como o ${device.manufacturer} ${device.model} opera somente na banda 2,4 GHz (média real de ${wifiBandAverages.band24.speedRange}), este resultado está excelente e próximo ao teto físico do rádio Wi-Fi do smartphone, mesmo que o plano contratado ou roteador entreguem velocidades maiores.`;
  } else if (!isEntryOnly24 && ctxLink === 'wifi-24' && measuredDl < 95) {
    verdictBadge = 'LIMITAÇÃO PELA REDE 2,4 GHz';
    verdictTone = 'warning';
    analysis = `Embora o ${device.manufacturer} ${device.model} suporte redes mais rápidas (${displayWifiGen}), a conexão atual foi declarada em Wi-Fi 2,4 GHz. Para atingir a média esperada de ${wifiBandAverages.band5.speedRange}, conecte-se ao Wi-Fi 5 GHz${wifiBandAverages.band6.supported ? ' ou 6 GHz' : ''} do roteador.`;
  } else if (!isEntryOnly24 && ctxLink !== 'ethernet' && ctxLink !== 'wifi-24' && measuredDl < 90) {
    verdictBadge = 'ABAIXO DO POTENCIAL DO APARELHO';
    verdictTone = 'warning';
    analysis = `O ${device.manufacturer} ${device.model} (${displayWifiGen}) suporta média de ${wifiBandAverages.band5.speedRange} na banda de 5 GHz, mas você mediu ${formatSpeed(measuredDl)} Mbps. Verifique se o celular está conectado à rede 5 GHz (e não em 2,4 GHz), se há distância/barreiras até o roteador ou se o plano contratado é inferior.`;
  } else if (wifi.theoreticalLinkMbps && measuredDl < wifi.theoreticalLinkMbps * 0.35) {
    verdictBadge = 'APARELHO COM FOLGA TÉCNICA';
    verdictTone = 'good';
    analysis = `O ${device.manufacturer} ${device.model} possui capacidade para velocidades superiores (${displayWifiGen}, média de ${wifiBandAverages.band5.speedRange}). O resultado atual de ${formatSpeed(measuredDl)} Mbps pode estar limitado pelo plano contratado, pela distância do sinal ou pelo roteador.`;
  } else {
    verdictBadge = 'DESEMPENHO EQUILIBRADO';
    verdictTone = 'good';
    analysis = `A velocidade medida de ${formatSpeed(measuredDl)} Mbps está bem alinhada com a conectividade ${displayWifiGen} do ${device.manufacturer} ${device.model} (${category.tier}).`;
  }

  return {
    deviceName: `${device.manufacturer} ${device.model}`,
    regionalVariant: device.regionalVariant,
    category,
    wifiBandAverages,
    compatibilitySummary,
    hardwareSummary,
    channelWidthsLabel: channelLabel,
    mobileBandsSummary,
    sixGhzNote,
    tiers: {
      theoretical: theoreticalText,
      favorableEstimate: favorableText,
      measured: measuredSummary
    },
    verdictBadge,
    verdictTone,
    analysis,
    source: device.source,
    dataVersion: device.dataVersion
  };
}
