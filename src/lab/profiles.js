/**
 * Perfis candidatos e estatísticas puras para o ambiente isolado de benchmark (TestAi Lab).
 * Não é importado pelo aplicativo de produção.
 */

export const CANDIDATE_PROFILES = [
  {
    id: 'A',
    key: 'atual',
    name: 'A: Atual',
    shortName: 'A: Atual',
    description:
      'Configuração atual do TestAi (100 KB x6 -> 1 MB x6 -> 10 MB x5 -> 25 MB x4 -> 100 MB x2; freio 1000 ms).',
    options: {
      autoStart: false,
      logAimApiUrl: null,
      measureDownloadLoadedLatency: true,
      measureUploadLoadedLatency: true,
      loadedLatencyThrottle: 400,
      bandwidthFinishRequestDuration: 1000,
      bandwidthAbortRequestDuration: 0,
      latencyPercentile: 0.5,
      bandwidthPercentile: 0.5,
      bandwidthMinRequestDuration: 10,
      measurements: [
        { type: 'latency', numPackets: 1 },
        { type: 'download', bytes: 1e5, count: 1, bypassMinDuration: true },
        { type: 'latency', numPackets: 20 },
        { type: 'download', bytes: 1e5, count: 6 },
        { type: 'download', bytes: 1e6, count: 6 },
        { type: 'download', bytes: 1e7, count: 5 },
        { type: 'download', bytes: 2.5e7, count: 4 },
        { type: 'download', bytes: 1e8, count: 2 },
        { type: 'upload', bytes: 1e5, count: 6 },
        { type: 'upload', bytes: 1e6, count: 5 },
        { type: 'upload', bytes: 1e7, count: 4 },
        { type: 'upload', bytes: 2.5e7, count: 3 }
      ]
    }
  },
  {
    id: 'B',
    key: 'rampa-rapida',
    name: 'B: Rampa Rápida',
    shortName: 'B: Rampa Rápida',
    description:
      'Reduz sondagens pequenas (x2/x3) e acelera rapidamente para 10–100 MB (freio 1200 ms).',
    options: {
      autoStart: false,
      logAimApiUrl: null,
      measureDownloadLoadedLatency: true,
      measureUploadLoadedLatency: true,
      loadedLatencyThrottle: 400,
      bandwidthFinishRequestDuration: 1200,
      bandwidthAbortRequestDuration: 0,
      latencyPercentile: 0.5,
      bandwidthPercentile: 0.5,
      bandwidthMinRequestDuration: 10,
      measurements: [
        { type: 'latency', numPackets: 1 },
        { type: 'download', bytes: 1e5, count: 1, bypassMinDuration: true },
        { type: 'latency', numPackets: 15 },
        { type: 'download', bytes: 1e5, count: 2 },
        { type: 'download', bytes: 1e6, count: 3 },
        { type: 'download', bytes: 1e7, count: 5 },
        { type: 'download', bytes: 2.5e7, count: 5 },
        { type: 'download', bytes: 5e7, count: 4 },
        { type: 'download', bytes: 1e8, count: 3 },
        { type: 'upload', bytes: 1e5, count: 2 },
        { type: 'upload', bytes: 1e6, count: 3 },
        { type: 'upload', bytes: 1e7, count: 5 },
        { type: 'upload', bytes: 2.5e7, count: 4 },
        { type: 'upload', bytes: 5e7, count: 2 }
      ]
    }
  },
  {
    id: 'C',
    key: 'fluidez-continua',
    name: 'C: Fluidez Contínua',
    shortName: 'C: Fluidez Contínua',
    description:
      'Degraus intermediários suaves (500 KB -> 2 -> 5 -> 10 -> 25 -> 50 MB) com freio curto (750 ms) para menor Max Gap.',
    options: {
      autoStart: false,
      logAimApiUrl: null,
      measureDownloadLoadedLatency: true,
      measureUploadLoadedLatency: true,
      loadedLatencyThrottle: 350,
      bandwidthFinishRequestDuration: 750,
      bandwidthAbortRequestDuration: 0,
      latencyPercentile: 0.5,
      bandwidthPercentile: 0.5,
      bandwidthMinRequestDuration: 10,
      measurements: [
        { type: 'latency', numPackets: 1 },
        { type: 'download', bytes: 1e5, count: 1, bypassMinDuration: true },
        { type: 'latency', numPackets: 15 },
        { type: 'download', bytes: 5e5, count: 4 },
        { type: 'download', bytes: 2e6, count: 6 },
        { type: 'download', bytes: 5e6, count: 6 },
        { type: 'download', bytes: 1e7, count: 6 },
        { type: 'download', bytes: 2.5e7, count: 6 },
        { type: 'download', bytes: 5e7, count: 4 },
        { type: 'upload', bytes: 5e5, count: 4 },
        { type: 'upload', bytes: 2e6, count: 5 },
        { type: 'upload', bytes: 5e6, count: 5 },
        { type: 'upload', bytes: 1e7, count: 5 },
        { type: 'upload', bytes: 2.5e7, count: 4 }
      ]
    }
  },
  {
    id: 'D',
    key: 'hibrido-sustentado',
    name: 'D: Híbrido Sustentado',
    shortName: 'D: Híbrido Sustentado',
    description:
      'Equilibra degraus progressivos (500 KB -> 2 -> 5 -> 10 -> 25 -> 50 -> 100 MB), freio de 1100 ms e teto de abort em 8000 ms.',
    options: {
      autoStart: false,
      logAimApiUrl: null,
      measureDownloadLoadedLatency: true,
      measureUploadLoadedLatency: true,
      loadedLatencyThrottle: 350,
      bandwidthFinishRequestDuration: 1100,
      bandwidthAbortRequestDuration: 8000,
      latencyPercentile: 0.5,
      bandwidthPercentile: 0.5,
      bandwidthMinRequestDuration: 10,
      measurements: [
        { type: 'latency', numPackets: 1 },
        { type: 'download', bytes: 1e5, count: 1, bypassMinDuration: true },
        { type: 'latency', numPackets: 20 },
        { type: 'download', bytes: 5e5, count: 2 },
        { type: 'download', bytes: 2e6, count: 4 },
        { type: 'download', bytes: 5e6, count: 5 },
        { type: 'download', bytes: 1e7, count: 6 },
        { type: 'download', bytes: 2.5e7, count: 6 },
        { type: 'download', bytes: 5e7, count: 5 },
        { type: 'download', bytes: 1e8, count: 3 },
        { type: 'upload', bytes: 5e5, count: 2 },
        { type: 'upload', bytes: 2e6, count: 4 },
        { type: 'upload', bytes: 5e6, count: 5 },
        { type: 'upload', bytes: 1e7, count: 5 },
        { type: 'upload', bytes: 2.5e7, count: 4 },
        { type: 'upload', bytes: 5e7, count: 3 }
      ]
    }
  }
];

export function computePercentile(values, percentile = 0.5) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * percentile;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const rem = idx - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * rem;
}

export function summarizeBandwidthPoints(points, minDurationMs = 10) {
  const valid = (Array.isArray(points) ? points : []).filter(
    (pt) =>
      pt &&
      typeof pt.bps === 'number' &&
      Number.isFinite(pt.bps) &&
      pt.bps > 0 &&
      (typeof pt.duration !== 'number' || pt.duration >= minDurationMs)
  );

  const allMbps = valid.map((pt) => pt.bps / 1_000_000);
  const sustainedPoints = valid.filter((pt) => Number(pt.bytes) >= 1_000_000);
  const sustainedMbps = sustainedPoints.map((pt) => pt.bps / 1_000_000);

  const medianTotalMbps = computePercentile(allMbps, 0.5);
  const medianSustainedMbps =
    sustainedMbps.length > 0 ? computePercentile(sustainedMbps, 0.5) : medianTotalMbps;
  const p90Mbps = computePercentile(allMbps, 0.9);
  const totalBytes = valid.reduce((acc, pt) => acc + (Number(pt.bytes) || 0), 0);

  const p90InflationPct =
    medianSustainedMbps && p90Mbps
      ? ((p90Mbps - medianSustainedMbps) / medianSustainedMbps) * 100
      : null;

  return {
    count: valid.length,
    sustainedCount: sustainedPoints.length,
    usedFallback: sustainedPoints.length === 0 && valid.length > 0,
    medianTotalMbps,
    medianSustainedMbps,
    p90Mbps,
    p90InflationPct,
    totalBytes
  };
}

export function formatBytesCompact(bytes) {
  const num = Number(bytes) || 0;
  if (num >= 1_000_000) {
    const mb = num / 1_000_000;
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  if (num >= 1_000) {
    const kb = num / 1_000;
    return `${Number.isInteger(kb) ? kb : kb.toFixed(0)} KB`;
  }
  return `${num} B`;
}
