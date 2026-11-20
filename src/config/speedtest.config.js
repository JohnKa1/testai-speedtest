/**
 * Configurações de medição e critérios técnicos de diagnóstico do TestAi.
 * Compatível com @cloudflare/speedtest ^1.13.1.
 */

export const TEST_PROFILES = {
  light: {
    id: 'light',
    label: 'Econômico / Móvel (4G/5G)',
    description: 'Consumo reduzido (~35–85 MB). Ideal para redes móveis ou triagem rápida.',
    estimatedDataLabel: '~35–85 MB',
    timeoutMs: 60_000,
    inactivityTimeoutMs: 18_000,
    options: {
      autoStart: false,
      measureDownloadLoadedLatency: true,
      measureUploadLoadedLatency: true,
      loadedLatencyThrottle: 400,
      latencyPercentile: 0.5,
      bandwidthPercentile: 0.9,
      measurements: [
        { type: 'latency', numPackets: 1 },
        { type: 'download', bytes: 1e5, count: 1, bypassMinDuration: true },
        { type: 'latency', numPackets: 15 },
        { type: 'download', bytes: 1e5, count: 6 },
        { type: 'download', bytes: 1e6, count: 6 },
        { type: 'download', bytes: 1e7, count: 3 },
        { type: 'upload', bytes: 1e5, count: 6 },
        { type: 'upload', bytes: 1e6, count: 5 },
        { type: 'upload', bytes: 1e7, count: 2 }
      ]
    }
  },

  standard: {
    id: 'standard',
    label: 'Padrão Adaptativo (100 Mbps – 1 Gbps)',
    description: 'Fases contínuas de latência, download e upload equilibrando precisão e tempo (~180–360 MB).',
    estimatedDataLabel: '~180–360 MB',
    timeoutMs: 90_000,
    inactivityTimeoutMs: 22_000,
    options: {
      autoStart: false,
      measureDownloadLoadedLatency: true,
      measureUploadLoadedLatency: true,
      loadedLatencyThrottle: 400,
      latencyPercentile: 0.5,
      bandwidthPercentile: 0.9,
      measurements: [
        // 1. Aquecimento de conexão (TLS/HTTP) + Latência ociosa isolada
        { type: 'latency', numPackets: 1 },
        { type: 'download', bytes: 1e5, count: 1, bypassMinDuration: true },
        { type: 'latency', numPackets: 20 },

        // 2. Fase contínua de Download + RTT sob Download
        { type: 'download', bytes: 1e5, count: 6 },
        { type: 'download', bytes: 1e6, count: 6 },
        { type: 'download', bytes: 1e7, count: 5 },
        { type: 'download', bytes: 2.5e7, count: 4 },
        { type: 'download', bytes: 1e8, count: 2 },

        // 3. Fase contínua de Upload + RTT sob Upload
        { type: 'upload', bytes: 1e5, count: 6 },
        { type: 'upload', bytes: 1e6, count: 5 },
        { type: 'upload', bytes: 1e7, count: 4 },
        { type: 'upload', bytes: 2.5e7, count: 3 }
      ]
    }
  },

  multigig: {
    id: 'multigig',
    label: 'Alta Capacidade (1 Gbps – 2,5 Gbps+)',
    description: 'Rajadas de 100 MB e 250 MB para saturação completa de enlaces Gigabit e Multi-Gigabit.',
    estimatedDataLabel: '~650–980 MB',
    timeoutMs: 120_000,
    inactivityTimeoutMs: 25_000,
    options: {
      autoStart: false,
      measureDownloadLoadedLatency: true,
      measureUploadLoadedLatency: true,
      loadedLatencyThrottle: 400,
      latencyPercentile: 0.5,
      bandwidthPercentile: 0.9,
      measurements: [
        // 1. Aquecimento + Latência ociosa isolada
        { type: 'latency', numPackets: 1 },
        { type: 'download', bytes: 1e5, count: 1, bypassMinDuration: true },
        { type: 'latency', numPackets: 20 },

        // 2. Fase contínua de Download Multi-Gigabit
        { type: 'download', bytes: 1e6, count: 6 },
        { type: 'download', bytes: 1e7, count: 6 },
        { type: 'download', bytes: 2.5e7, count: 4 },
        { type: 'download', bytes: 1e8, count: 3 },
        { type: 'download', bytes: 2.5e8, count: 2 },

        // 3. Fase contínua de Upload Multi-Gigabit
        { type: 'upload', bytes: 1e6, count: 6 },
        { type: 'upload', bytes: 1e7, count: 4 },
        { type: 'upload', bytes: 2.5e7, count: 4 },
        { type: 'upload', bytes: 5e7, count: 3 }
      ]
    }
  }
};

export const DIAGNOSTIC_THRESHOLDS = {
  // Latência ociosa (ms)
  idlePingExcellentMax: 20,
  idlePingGoodMax: 45,
  idlePingElevatedMax: 85,

  // Jitter ocioso e carregado (ms)
  jitterGoodMax: 8,
  jitterElevatedMax: 20,
  loadedJitterInstabilityMin: 25,

  // Aumento de latência sob carga (ΔRTT = loaded - idle, ms)
  loadedDeltaGoodMax: 20,
  loadedDeltaModerateMax: 55,
  loadedDeltaBufferbloatMin: 60,

  // Vazão (Mbps)
  lowDownloadMbps: 35,
  lowUploadMbps: 10,
  highSpeedDownloadMbps: 150,
  contractDeliveryRatioMin: 0.7,

  // Estabilidade temporal (coeficiente de variação = stdDev / mean)
  throughputCvInstabilityMin: 0.38,
  minThroughputPoints: 3,
  minLatencyPoints: 5
};

export const GAMING_THRESHOLDS = {
  pingCompetitiveMax: 25,
  pingPlayableMax: 55,
  pingLagRiskMax: 90,

  jitterCompetitiveMax: 5,
  jitterPlayableMax: 15,

  loadedDeltaCompetitiveMax: 15,
  loadedDeltaPlayableMax: 40
};