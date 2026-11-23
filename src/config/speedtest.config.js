/**
 * Configurações de medição multi-stream resiliente e critérios técnicos de diagnóstico do TestAi.
 */

import { DEFAULT_RUNTIME_CONFIG } from '../services/runtime-config.js';

const COMMON_ENGINE_OPTIONS = Object.freeze({
  downloadApiUrl: DEFAULT_RUNTIME_CONFIG.endpoints.down,
  uploadApiUrl: DEFAULT_RUNTIME_CONFIG.endpoints.up,
  pingApiUrl: DEFAULT_RUNTIME_CONFIG.endpoints.ping,
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
      maxDownloadBytes: 10_000_000,
      initialUploadBytes: 131_072,
      maxUploadBytes: 2_000_000
    }
  },

  standard: {
    id: 'standard',
    label: 'Padrão Adaptativo (100 Mbps – 1 Gbps)',
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
      maxDownloadBytes: 25_000_000,
      initialUploadBytes: 262_144,
      maxUploadBytes: 4_000_000
    }
  },

  multigig: {
    id: 'multigig',
    label: 'Alta Capacidade (1 Gbps – 2,5 Gbps+)',
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
      maxDownloadBytes: 50_000_000,
      initialUploadBytes: 524_288,
      maxUploadBytes: 5_000_000
    }
  },

  stability: {
    id: 'stability',
    label: 'Estabilidade Prolongada (Bufferbloat)',
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
      maxDownloadBytes: 25_000_000,
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
