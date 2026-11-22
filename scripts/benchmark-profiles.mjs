/**
 * Simulador Offline Determinístico de Perfis de Medição (TestAi Lab).
 * Execução: node scripts/benchmark-profiles.mjs
 * Não altera nenhum arquivo de produção.
 */

import {
  CANDIDATE_PROFILES,
  computePercentile,
  summarizeBandwidthPoints
} from '../src/lab/profiles.js';

const SCENARIOS = [
  {
    id: 'wifi-24-35m',
    label: 'Wi-Fi 2,4 GHz (35 Mbps | RTT 25 ms)',
    downloadMbps: 35,
    uploadMbps: 15,
    rttMs: 25,
    natBoostMbps: 0,
    natBoostDurationMs: 0,
    slowStartEnabled: true
  },
  {
    id: 'fibra-300m',
    label: 'Fibra 300 Mbps (300 Mbps | RTT 6 ms)',
    downloadMbps: 300,
    uploadMbps: 150,
    rttMs: 6,
    natBoostMbps: 0,
    natBoostDurationMs: 0,
    slowStartEnabled: true
  },
  {
    id: 'fibra-1g',
    label: 'Fibra 1 Gbps (940 Mbps | RTT 4 ms)',
    downloadMbps: 940,
    uploadMbps: 470,
    rttMs: 4,
    natBoostMbps: 0,
    natBoostDurationMs: 0,
    slowStartEnabled: true
  },
  {
    id: 'fibra-300m-natboost',
    label: 'Fibra 300M + NAT Boost (520 Mbps por 1,2s -> 300 Mbps | RTT 6 ms)',
    downloadMbps: 300,
    uploadMbps: 150,
    rttMs: 6,
    natBoostMbps: 520,
    natBoostDurationMs: 1200,
    slowStartEnabled: true
  }
];

function simulateRequestTransfer({
  bytes,
  baseMbps,
  rttMs,
  phaseElapsedMs,
  requestIndex,
  scenario,
  connectionWarm,
  abortMs
}) {
  const payloadBytes = bytes * 1.005;
  const baseBytesPerMs = (baseMbps * 1_000_000) / 8 / 1000;
  const boostBytesPerMs =
    scenario.natBoostMbps > baseMbps ? (scenario.natBoostMbps * 1_000_000) / 8 / 1000 : baseBytesPerMs;

  // TCP Slow Start realista (IW10 = 14.6 KB dobrando a cada RTT quando conexão recém-abriu ou em fase inicial)
  const bdpBytes = baseBytesPerMs * rttMs;
  const initialCwnd = connectionWarm ? Math.max(29_200, bdpBytes * 0.45) : 14_600;
  let cwnd = initialCwnd;
  let remaining = payloadBytes;
  let transferMs = 0;

  // Overhead de solicitação HTTP/TLS (1 RTT no envio/resposta + handshake extra no primeiro pacote frio)
  const handshakeMs = connectionWarm ? 0 : rttMs * 1.5;
  let reqElapsedFromPhaseStart = phaseElapsedMs + rttMs + handshakeMs;

  while (remaining > 0) {
    if (abortMs > 0 && rttMs + handshakeMs + transferMs >= abortMs) {
      return {
        aborted: true,
        durationMs: abortMs,
        bps: 0
      };
    }

    const inBoostWindow =
      scenario.natBoostDurationMs > 0 && reqElapsedFromPhaseStart < scenario.natBoostDurationMs;
    const linkRateBytesPerMs = inBoostWindow ? boostBytesPerMs : baseBytesPerMs;

    // Micro-variação determinística (±1,8%) típica de fila/modulação
    const wave = 1 + 0.018 * Math.sin((reqElapsedFromPhaseStart + requestIndex * 37) * 0.013);
    const effectiveLinkBytesPerMs = linkRateBytesPerMs * wave;

    let capBytesPerMs = effectiveLinkBytesPerMs;
    if (scenario.slowStartEnabled) {
      const rttsElapsed = Math.floor(transferMs / Math.max(1, rttMs));
      cwnd = Math.min(Math.max(bdpBytes * 1.4, initialCwnd), initialCwnd * Math.pow(2, rttsElapsed));
      const cwndRateBytesPerMs = cwnd / Math.max(1, rttMs);
      capBytesPerMs = Math.min(effectiveLinkBytesPerMs, cwndRateBytesPerMs);
    }

    const stepMs = 1;
    const delivered = Math.min(remaining, capBytesPerMs * stepMs);
    remaining -= delivered;
    transferMs += stepMs;
    reqElapsedFromPhaseStart += stepMs;
  }

  const durationMs = rttMs + handshakeMs + transferMs;
  const bps = (payloadBytes * 8) / (durationMs / 1000);
  return {
    aborted: false,
    durationMs,
    bps
  };
}

function simulateProfile(profile, scenario) {
  const opts = profile.options;
  const finishLimit = opts.bandwidthFinishRequestDuration ?? 1000;
  const abortLimit = opts.bandwidthAbortRequestDuration ?? 0;
  const minReqDuration = opts.bandwidthMinRequestDuration ?? 10;

  const finishedDir = { download: false, upload: false };
  const downloadPoints = [];
  const uploadPoints = [];

  let totalTimeMs = 0;
  let downloadStartMs = null;
  let ramp80Ms = null;
  let lastBlockCompletedAtMs = 0;
  let maxGapMs = 0;
  let connectionWarm = false;
  let requestSeq = 0;
  let abortedAny = false;

  const phaseElapsed = { download: 0, upload: 0 };

  for (const step of opts.measurements) {
    if (step.type === 'latency') {
      totalTimeMs += step.numPackets * scenario.rttMs;
      continue;
    }

    const dir = step.type;
    if (dir !== 'download' && dir !== 'upload') continue;
    if (finishedDir[dir]) continue;

    if (dir === 'download' && downloadStartMs === null) {
      downloadStartMs = totalTimeMs;
      lastBlockCompletedAtMs = totalTimeMs;
    }

    const baseMbps = dir === 'download' ? scenario.downloadMbps : scenario.uploadMbps;
    let stepMinDuration = Infinity;

    for (let i = 0; i < step.count; i++) {
      requestSeq += 1;
      const sim = simulateRequestTransfer({
        bytes: step.bytes,
        baseMbps,
        rttMs: scenario.rttMs,
        phaseElapsedMs: phaseElapsed[dir],
        requestIndex: requestSeq,
        scenario,
        connectionWarm,
        abortMs: abortLimit
      });

      connectionWarm = true;
      totalTimeMs += sim.durationMs;
      phaseElapsed[dir] += sim.durationMs;

      if (sim.aborted) {
        abortedAny = true;
        finishedDir[dir] = true;
        maxGapMs = Math.max(maxGapMs, sim.durationMs);
        break;
      }

      const gapMs = totalTimeMs - lastBlockCompletedAtMs;
      if (gapMs > maxGapMs) {
        maxGapMs = gapMs;
      }
      lastBlockCompletedAtMs = totalTimeMs;

      const point = {
        bytes: step.bytes,
        bps: sim.bps,
        duration: sim.durationMs
      };

      if (dir === 'download') {
        downloadPoints.push(point);
        const mbps = sim.bps / 1_000_000;
        if (ramp80Ms === null && mbps >= scenario.downloadMbps * 0.8) {
          ramp80Ms = totalTimeMs - downloadStartMs;
        }
      } else {
        uploadPoints.push(point);
      }

      stepMinDuration = Math.min(stepMinDuration, sim.durationMs);
    }

    if (stepMinDuration > finishLimit && !step.bypassMinDuration) {
      finishedDir[dir] = true;
    }
  }

  const dlSummary = summarizeBandwidthPoints(downloadPoints, minReqDuration);
  const ulSummary = summarizeBandwidthPoints(uploadPoints, minReqDuration);

  const medTotalErrPct =
    dlSummary.medianTotalMbps !== null
      ? ((dlSummary.medianTotalMbps - scenario.downloadMbps) / scenario.downloadMbps) * 100
      : 100;
  const medSustErrPct =
    dlSummary.medianSustainedMbps !== null
      ? ((dlSummary.medianSustainedMbps - scenario.downloadMbps) / scenario.downloadMbps) * 100
      : 100;

  const p90Mbps = computePercentile(
    downloadPoints.filter((p) => p.duration >= minReqDuration).map((p) => p.bps / 1_000_000),
    0.9
  );

  const totalBytes = dlSummary.totalBytes + ulSummary.totalBytes;
  const maxGapSec = maxGapMs / 1000;
  const durationSec = totalTimeMs / 1000;
  const ramp80Sec = ramp80Ms !== null ? ramp80Ms / 1000 : durationSec;
  const totalMB = totalBytes / 1_000_000;

  let timeoutRisk = 'BAIXO';
  if (abortedAny || maxGapSec > 8) timeoutRisk = 'ALTO (>8s)';
  else if (maxGapSec > 4) timeoutRisk = 'ATENÇÃO (>4s)';

  // Score (0-100): precisão sustentada (40), precisão total (15), fluidez maxGap (20), ramp-up (10), eficiência/risco (15)
  const sustAccuracyPts = Math.max(0, 40 - Math.abs(medSustErrPct) * 2.2);
  const totalAccuracyPts = Math.max(0, 15 - Math.abs(medTotalErrPct) * 0.75);
  const gapPts =
    maxGapSec <= 1.2
      ? 20
      : maxGapSec <= 2.5
        ? 17 - (maxGapSec - 1.2) * 3
        : maxGapSec <= 5
          ? 12 - (maxGapSec - 2.5) * 3.2
          : Math.max(0, 4 - (maxGapSec - 5) * 1.2);
  const rampPts = Math.max(0, 10 - Math.max(0, ramp80Sec - 0.15) * 3.5);
  const efficiencyPts =
    (abortedAny || maxGapSec > 8 ? 0 : maxGapSec > 4 ? 5 : 9) +
    Math.max(0, 6 - Math.max(0, durationSec - 14) * 0.4);

  const score = Math.round((sustAccuracyPts + totalAccuracyPts + gapPts + rampPts + efficiencyPts) * 10) / 10;

  return {
    profileId: profile.id,
    profileName: profile.name,
    scenarioId: scenario.id,
    targetMbps: scenario.downloadMbps,
    medianTotalMbps: dlSummary.medianTotalMbps ?? 0,
    medianSustainedMbps: dlSummary.medianSustainedMbps ?? 0,
    p90Mbps: p90Mbps ?? 0,
    medTotalErrPct,
    medSustErrPct,
    maxGapSec,
    ramp80Sec,
    durationSec,
    totalMB,
    sampleCount: `${dlSummary.count}↓/${ulSummary.count}↑`,
    timeoutRisk,
    score
  };
}

function padRight(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function padLeft(str, len) {
  const s = String(str);
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

function fmtSignedPct(val) {
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(1)}%`;
}

function printScenarioTable(scenario, rows) {
  console.log(`\n=== ${scenario.label} ===`);
  const header = [
    padRight('Perfil', 22),
    padLeft('Med.Total', 10),
    padLeft('Err.Tot', 9),
    padLeft('Med.Sust>=1M', 13),
    padLeft('Err.Sust', 9),
    padLeft('P90(Ref)', 9),
    padLeft('MaxGap', 8),
    padLeft('Ramp80%', 8),
    padLeft('Duração', 8),
    padLeft('Vol(MB)', 8),
    padRight('  Risco', 13),
    padLeft('Score', 6)
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const r of rows) {
    console.log(
      [
        padRight(r.profileName, 22),
        padLeft(`${r.medianTotalMbps.toFixed(1)}M`, 10),
        padLeft(fmtSignedPct(r.medTotalErrPct), 9),
        padLeft(`${r.medianSustainedMbps.toFixed(1)}M`, 13),
        padLeft(fmtSignedPct(r.medSustErrPct), 9),
        padLeft(`${r.p90Mbps.toFixed(1)}M`, 9),
        padLeft(`${r.maxGapSec.toFixed(2)}s`, 8),
        padLeft(`${r.ramp80Sec.toFixed(2)}s`, 8),
        padLeft(`${r.durationSec.toFixed(1)}s`, 8),
        padLeft(`${r.totalMB.toFixed(0)}`, 8),
        padRight(`  ${r.timeoutRisk}`, 13),
        padLeft(`${r.score.toFixed(1)}`, 6)
      ].join(' | ')
    );
  }
}

function runBenchmark() {
  console.log('TESTAI LAB — SIMULAÇÃO OFFLINE DE PERFIS DE MEDIÇÃO (P50 TOTAL vs. SUSTENTADA >= 1 MB)');
  const allResults = [];

  for (const scenario of SCENARIOS) {
    const scenarioRows = CANDIDATE_PROFILES.map((profile) => simulateProfile(profile, scenario));
    allResults.push(...scenarioRows);
    printScenarioTable(scenario, scenarioRows);
  }

  // Ranking consolidado entre todos os cenários
  const summary = CANDIDATE_PROFILES.map((profile) => {
    const rows = allResults.filter((r) => r.profileId === profile.id);
    const avgScore = rows.reduce((a, r) => a + r.score, 0) / rows.length;
    const avgAbsErrSust = rows.reduce((a, r) => a + Math.abs(r.medSustErrPct), 0) / rows.length;
    const avgAbsErrTotal = rows.reduce((a, r) => a + Math.abs(r.medTotalErrPct), 0) / rows.length;
    const worstGap = Math.max(...rows.map((r) => r.maxGapSec));
    const avgRamp = rows.reduce((a, r) => a + r.ramp80Sec, 0) / rows.length;
    const avgDuration = rows.reduce((a, r) => a + r.durationSec, 0) / rows.length;
    const hasHighRisk = rows.some((r) => r.timeoutRisk.startsWith('ALTO'));

    return {
      profileId: profile.id,
      profileName: profile.name,
      avgScore,
      avgAbsErrSust,
      avgAbsErrTotal,
      worstGap,
      avgRamp,
      avgDuration,
      hasHighRisk
    };
  }).sort((a, b) => b.avgScore - a.avgScore);

  console.log('\n=== RANKING CONSOLIDADO (MÉDIA DOS 4 CENÁRIOS) ===');
  const rankHeader = [
    padRight('Pos', 4),
    padRight('Perfil', 22),
    padLeft('Score Médio', 12),
    padLeft('|Err.Sust|', 11),
    padLeft('|Err.Total|', 12),
    padLeft('Pior MaxGap', 12),
    padLeft('Ramp Médio', 11),
    padLeft('Duração Méd', 12)
  ].join(' | ');
  console.log(rankHeader);
  console.log('-'.repeat(rankHeader.length));

  summary.forEach((s, idx) => {
    console.log(
      [
        padRight(`#${idx + 1}`, 4),
        padRight(s.profileName, 22),
        padLeft(`${s.avgScore.toFixed(1)}`, 12),
        padLeft(`${s.avgAbsErrSust.toFixed(2)}%`, 11),
        padLeft(`${s.avgAbsErrTotal.toFixed(2)}%`, 12),
        padLeft(`${s.worstGap.toFixed(2)}s`, 12),
        padLeft(`${s.avgRamp.toFixed(2)}s`, 11),
        padLeft(`${s.avgDuration.toFixed(1)}s`, 12)
      ].join(' | ')
    );
  });

  console.log(
    `\n>>> FINALISTAS RECOMENDADOS PARA BANCADA REAL: ${summary[0].profileName} (#1) e ${summary[1].profileName} (#2)`
  );
}

runBenchmark();
