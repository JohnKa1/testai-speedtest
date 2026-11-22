/**
 * Configurações de medição multi-stream resiliente e critérios técnicos de diagnóstico do TestAi.
 */

const COMMON_ENGINE_OPTIONS = Object.freeze({
  autoStart: false,
  downloadApiUrl: 'https://speed.cloudflare.com/__down',
  uploadApiUrl: 'https://speed.cloudflare.com/__up',
  measureDownloadLoadedLatency: true,
  measureUploadLoadedLatency: true,
  latencyPercentile: 0.5,
  bandwidthPercentile: 0.5,
  sampleIntervalMs: 250,
  rollingWindowMs: 1000,
  rampDiscardMs: 1000,
  downloadStallTimeoutMs: 2000,
  uploadStallTimeoutMs: 2800,
  pingTimeoutMs: 1200
});

export const TEST_PROFILES = {
  light: {
    id: 'light',
    label: 'Econômico / Móvel (4G/5G)',
    description: 'Ciclo rápido multi-fluxo (~4,5s por fase) ideal para redes móveis ou triagem rápida.',
    estimatedDataLabel: '~35–140 MB',
    timeoutMs: 45_000,
    inactivityTimeoutMs: 15_000,
    options: {
      ...COMMON_ENGINE_OPTIONS,
      loadedLatencyThrottle: 400,
      idlePingCount: 8,
      maxIdleLatencyMs: 1600,
      downloadDurationMs: 4500,
      uploadDurationMs: 4500,
      downloadConcurrency: 3,
      uploadConcurrency: 3,
      initialDownloadBytes: 1_000_000,
      maxDownloadBytes: 2_000_000,
      initialUploadBytes: 131_072,
      maxUploadBytes: 2_000_000
    }
  },

  standard: {
    id: 'standard',
    label: 'Padrão Adaptativo (100 Mbps – 1 Gbps)',
    description: 'Fluxos paralelos contínuos com adaptação de bloco e recuperação instantânea de stalls (~6,5s por fase).',
    estimatedDataLabel: '~120–450 MB',
    timeoutMs: 55_000,
    inactivityTimeoutMs: 18_000,
    options: {
      ...COMMON_ENGINE_OPTIONS,
      loadedLatencyThrottle: 400,
      idlePingCount: 10,
      maxIdleLatencyMs: 2000,
      downloadDurationMs: 6500,
      uploadDurationMs: 6500,
      downloadConcurrency: 4,
      uploadConcurrency: 4,
      initialDownloadBytes: 2_000_000,
      maxDownloadBytes: 5_000_000,
      initialUploadBytes: 262_144,
      maxUploadBytes: 4_000_000
    }
  },

  multigig: {
    id: 'multigig',
    label: 'Alta Capacidade (1 Gbps – 2,5 Gbps+)',
    description: 'Até 6 fluxos paralelos contínuos para saturação completa de links Gigabit e Multi-Gigabit.',
    estimatedDataLabel: '~350–950 MB',
    timeoutMs: 70_000,
    inactivityTimeoutMs: 20_000,
    options: {
      ...COMMON_ENGINE_OPTIONS,
      loadedLatencyThrottle: 400,
      idlePingCount: 10,
      maxIdleLatencyMs: 2000,
      downloadDurationMs: 8000,
      uploadDurationMs: 8000,
      downloadConcurrency: 6,
      uploadConcurrency: 4,
      initialDownloadBytes: 2_000_000,
      maxDownloadBytes: 10_000_000,
      initialUploadBytes: 524_288,
      maxUploadBytes: 5_000_000
    }
  },

  stability: {
    id: 'stability',
    label: 'Estabilidade Prolongada (Bufferbloat)',
    description: 'Sondagens estendidas de latência ociosa e 9s contínuos sob carga para avaliar bufferbloat e variação temporal.',
    estimatedDataLabel: '~220–620 MB',
    timeoutMs: 75_000,
    inactivityTimeoutMs: 20_000,
    options: {
      ...COMMON_ENGINE_OPTIONS,
      loadedLatencyThrottle: 300,
      idlePingCount: 16,
      maxIdleLatencyMs: 2800,
      downloadDurationMs: 9000,
      uploadDurationMs: 9000,
      downloadConcurrency: 4,
      uploadConcurrency: 4,
      initialDownloadBytes: 2_000_000,
      maxDownloadBytes: 5_000_000,
      initialUploadBytes: 262_144,
      maxUploadBytes: 4_000_000
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
