/**
 * Controlador da Bancada Real Isolada (TestAi Lab - lab.html).
 * Executa perfis reais contra a Cloudflare Edge via @cloudflare/speedtest.
 * Não afeta nenhum módulo de produção.
 */

import SpeedTest from '@cloudflare/speedtest';
import {
  CANDIDATE_PROFILES,
  formatBytesCompact,
  summarizeBandwidthPoints
} from './lab/profiles.js';

const COOLDOWN_SECONDS = 10;
const INACTIVITY_TIMEOUT_MS = 15_000;
const TOTAL_TIMEOUT_MS = 95_000;

const DEFAULT_FINALIST_1 = 'D';
const DEFAULT_FINALIST_2 = 'B';

const state = {
  isRunning: false,
  cancelRequested: false,
  activeEngine: null,
  cooldownTimerId: null,
  elapsedTimerId: null,
  runSequence: 0,
  blockCounter: 0,
  results: []
};

function clearEl(el) {
  while (el && el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function makeEl(tag, className = '', text = null) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== null && text !== undefined) el.textContent = String(text);
  return el;
}

function setStatus(tone, text, timerText = null) {
  const bar = document.getElementById('labStatusBar');
  const txt = document.getElementById('labStatusText');
  const timer = document.getElementById('labTimerText');
  if (bar) {
    bar.className = tone ? `status-bar ${tone}` : 'status-bar';
  }
  if (txt) txt.textContent = text;
  if (timer && timerText !== null) timer.textContent = timerText;
}

function syncButtons() {
  document.querySelectorAll('.profile-run-btn').forEach((btn) => {
    btn.disabled = state.isRunning;
  });
  const finalistsBtn = document.getElementById('runFinalistsBtn');
  const cancelBtn = document.getElementById('cancelRunBtn');
  const clearBtn = document.getElementById('clearResultsBtn');
  const copyTextBtn = document.getElementById('copyTextBtn');
  const copyJsonBtn = document.getElementById('copyJsonBtn');

  if (finalistsBtn) finalistsBtn.disabled = state.isRunning;
  if (cancelBtn) cancelBtn.disabled = !state.isRunning;
  if (clearBtn) clearBtn.disabled = state.isRunning;
  if (copyTextBtn) copyTextBtn.disabled = state.results.length === 0;
  if (copyJsonBtn) copyJsonBtn.disabled = state.results.length === 0;
}

function renderProfileCards() {
  const grid = document.getElementById('profilesGrid');
  const sel1 = document.getElementById('finalist1Select');
  const sel2 = document.getElementById('finalist2Select');
  if (!grid || !sel1 || !sel2) return;

  clearEl(grid);
  clearEl(sel1);
  clearEl(sel2);

  CANDIDATE_PROFILES.forEach((profile) => {
    const tile = makeEl('article', 'profile-tile');
    const info = makeEl('div', '');
    info.appendChild(makeEl('div', 'profile-title', profile.name));
    info.appendChild(makeEl('p', 'profile-desc', profile.description));
    tile.appendChild(info);

    const btn = makeEl('button', 'profile-run-btn', `Testar ${profile.id}`);
    btn.type = 'button';
    btn.addEventListener('click', () => runSingleProfile(profile));
    tile.appendChild(btn);
    grid.appendChild(tile);

    const opt1 = makeEl('option', '', profile.name);
    opt1.value = profile.id;
    opt1.selected = profile.id === DEFAULT_FINALIST_1;
    sel1.appendChild(opt1);

    const opt2 = makeEl('option', '', profile.name);
    opt2.value = profile.id;
    opt2.selected = profile.id === DEFAULT_FINALIST_2;
    sel2.appendChild(opt2);
  });
}

function appendBlockLogRow(entry) {
  const tbody = document.getElementById('blockLogBody');
  if (!tbody) return;

  if (tbody.firstElementChild?.firstElementChild?.colSpan === 7) {
    clearEl(tbody);
  }

  const tr = document.createElement('tr');
  tr.appendChild(makeEl('td', 'mono', String(entry.seq)));
  tr.appendChild(makeEl('td', '', entry.profileId));
  tr.appendChild(makeEl('td', 'mono', entry.dirLabel));
  tr.appendChild(makeEl('td', 'mono', formatBytesCompact(entry.bytes)));
  tr.appendChild(makeEl('td', 'mono', `${entry.durationMs.toFixed(0)} ms`));
  tr.appendChild(makeEl('td', 'mono', `${entry.mbps.toFixed(1)} Mbps`));
  tr.appendChild(
    makeEl(
      'td',
      'mono',
      entry.gapMs >= 1000
        ? `${(entry.gapMs / 1000).toFixed(2)} s`
        : `${entry.gapMs.toFixed(0)} ms`
    )
  );

  tbody.insertBefore(tr, tbody.firstChild);
}

function renderComparisonTable() {
  const tbody = document.getElementById('comparisonBody');
  if (!tbody) return;

  clearEl(tbody);
  if (state.results.length === 0) {
    const tr = document.createElement('tr');
    const td = makeEl('td', 'muted', 'Nenhuma execução registrada ainda.');
    td.colSpan = 8;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const fmtMbps = (val) => (typeof val === 'number' && Number.isFinite(val) ? `${val.toFixed(1)} Mbps` : '—');

  state.results.forEach((r) => {
    const tr = document.createElement('tr');
    tr.appendChild(makeEl('td', '', r.profileName));
    tr.appendChild(
      makeEl(
        'td',
        'mono',
        `↓ ${fmtMbps(r.dl.medianTotalMbps)} · ↑ ${fmtMbps(r.ul.medianTotalMbps)}`
      )
    );
    tr.appendChild(
      makeEl(
        'td',
        'mono',
        `↓ ${fmtMbps(r.dl.medianSustainedMbps)} · ↑ ${fmtMbps(r.ul.medianSustainedMbps)}`
      )
    );
    tr.appendChild(
      makeEl('td', 'mono', `↓ ${fmtMbps(r.dl.p90Mbps)} · ↑ ${fmtMbps(r.ul.p90Mbps)}`)
    );
    tr.appendChild(makeEl('td', 'mono', `${r.maxGapSec.toFixed(2)} s`));
    tr.appendChild(makeEl('td', 'mono', `${r.totalDurationSec.toFixed(1)} s`));
    tr.appendChild(makeEl('td', 'mono', `${r.dl.count} / ${r.ul.count}`));

    const statusTd = document.createElement('td');
    const badgeClass =
      r.status === 'OK' ? 'badge badge-ok' : r.status === 'Timeout' ? 'badge badge-warn' : 'badge badge-bad';
    statusTd.appendChild(makeEl('span', badgeClass, r.status));
    tr.appendChild(statusTd);

    tbody.appendChild(tr);
  });
}

function runProfileWithEngine(profile) {
  return new Promise((resolve) => {
    const runSeq = ++state.runSequence;
    const startedAt = performance.now();
    let lastBlockAt = startedAt;
    let lastActivityAt = startedAt;
    let maxGapMs = 0;
    let settled = false;

    const seenPerSize = new Map();
    let engine = null;
    let watchdogId = null;

    const cleanup = () => {
      if (watchdogId !== null) {
        clearInterval(watchdogId);
        watchdogId = null;
      }
      if (state.elapsedTimerId !== null) {
        clearInterval(state.elapsedTimerId);
        state.elapsedTimerId = null;
      }
      state.activeEngine = null;
    };

    const collectNewPoints = (points, dirLabel) => {
      const countsInRun = new Map();
      for (const pt of points) {
        const key = `${dirLabel}:${pt.bytes}`;
        const seen = seenPerSize.get(key) || 0;
        const idx = countsInRun.get(key) || 0;
        countsInRun.set(key, idx + 1);

        if (idx >= seen) {
          seenPerSize.set(key, idx + 1);
          const now = performance.now();
          const gapMs = now - lastBlockAt;
          if (gapMs > maxGapMs) maxGapMs = gapMs;
          lastBlockAt = now;

          appendBlockLogRow({
            seq: ++state.blockCounter,
            profileId: profile.id,
            dirLabel,
            bytes: Number(pt.bytes) || 0,
            durationMs: Number(pt.duration) || 0,
            mbps: (Number(pt.bps) || 0) / 1_000_000,
            gapMs
          });
        }
      }
    };

    const finalize = (status, resultsObj) => {
      if (settled) return;
      settled = true;
      cleanup();

      let dlPoints = [];
      let ulPoints = [];
      try {
        dlPoints = resultsObj?.getDownloadBandwidthPoints?.() || [];
        ulPoints = resultsObj?.getUploadBandwidthPoints?.() || [];
      } catch {
        // fallback vazio em falha precoce
      }

      const minDur = profile.options.bandwidthMinRequestDuration ?? 10;
      const dlSummary = summarizeBandwidthPoints(dlPoints, minDur);
      const ulSummary = summarizeBandwidthPoints(ulPoints, minDur);
      const totalDurationSec = (performance.now() - startedAt) / 1000;

      const record = {
        timestamp: new Date().toISOString(),
        profileId: profile.id,
        profileName: profile.name,
        status,
        maxGapSec: maxGapMs / 1000,
        totalDurationSec,
        dl: dlSummary,
        ul: ulSummary
      };

      state.results.push(record);
      renderComparisonTable();
      resolve(record);
    };

    setStatus('running', `Executando ${profile.name}...`, '0.0 s');
    state.elapsedTimerId = setInterval(() => {
      const elapsed = (performance.now() - startedAt) / 1000;
      setStatus('running', `Executando ${profile.name}...`, `${elapsed.toFixed(1)} s`);
    }, 200);

    try {
      engine = new SpeedTest(profile.options);
      state.activeEngine = engine;

      watchdogId = setInterval(() => {
        if (settled || runSeq !== state.runSequence) return;
        const now = performance.now();
        if (
          state.cancelRequested ||
          now - lastActivityAt > INACTIVITY_TIMEOUT_MS ||
          now - startedAt > TOTAL_TIMEOUT_MS
        ) {
          const reason = state.cancelRequested ? 'Cancelado' : 'Timeout';
          try {
            engine.pause();
          } catch {
            // noop
          }
          finalize(reason, engine.results);
        }
      }, 400);

      engine.onResultsChange = () => {
        if (settled || runSeq !== state.runSequence) return;
        lastActivityAt = performance.now();
        try {
          collectNewPoints(engine.results.getDownloadBandwidthPoints(), 'DL');
          collectNewPoints(engine.results.getUploadBandwidthPoints(), 'UL');
        } catch {
          // ignora leituras parciais durante latência
        }
      };

      engine.onFinish = (results) => {
        if (settled || runSeq !== state.runSequence) return;
        try {
          collectNewPoints(results.getDownloadBandwidthPoints(), 'DL');
          collectNewPoints(results.getUploadBandwidthPoints(), 'UL');
        } catch {
          // noop
        }
        finalize('OK', results);
      };

      engine.onError = () => {
        if (settled || runSeq !== state.runSequence) return;
        finalize('Erro', engine?.results);
      };

      engine.play();
    } catch {
      finalize('Erro', null);
    }
  });
}

function waitCooldownSeconds(seconds) {
  return new Promise((resolve) => {
    let remaining = seconds;
    setStatus(
      'cooldown',
      `Pausa obrigatória antes do próximo finalista para estabilizar a Cloudflare Edge...`,
      `${remaining}s`
    );

    state.cooldownTimerId = setInterval(() => {
      if (state.cancelRequested) {
        clearInterval(state.cooldownTimerId);
        state.cooldownTimerId = null;
        resolve(false);
        return;
      }
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(state.cooldownTimerId);
        state.cooldownTimerId = null;
        resolve(true);
      } else {
        setStatus(
          'cooldown',
          `Pausa obrigatória antes do próximo finalista para estabilizar a Cloudflare Edge...`,
          `${remaining}s`
        );
      }
    }, 1000);
  });
}

async function runSingleProfile(profile) {
  if (state.isRunning) return;
  state.isRunning = true;
  state.cancelRequested = false;
  syncButtons();

  const record = await runProfileWithEngine(profile);

  state.isRunning = false;
  syncButtons();
  setStatus(
    record.status === 'OK' ? '' : 'error',
    `${profile.name} finalizado (${record.status}).`,
    `${record.totalDurationSec.toFixed(1)} s`
  );
}

async function runTwoFinalists() {
  if (state.isRunning) return;
  const id1 = document.getElementById('finalist1Select')?.value || DEFAULT_FINALIST_1;
  const id2 = document.getElementById('finalist2Select')?.value || DEFAULT_FINALIST_2;
  const p1 = CANDIDATE_PROFILES.find((p) => p.id === id1);
  const p2 = CANDIDATE_PROFILES.find((p) => p.id === id2);
  if (!p1 || !p2) return;

  state.isRunning = true;
  state.cancelRequested = false;
  syncButtons();

  const r1 = await runProfileWithEngine(p1);
  if (state.cancelRequested || r1.status === 'Cancelado') {
    state.isRunning = false;
    syncButtons();
    setStatus('error', 'Sequência cancelada pelo usuário.', '0.0 s');
    return;
  }

  const continued = await waitCooldownSeconds(COOLDOWN_SECONDS);
  if (!continued || state.cancelRequested) {
    state.isRunning = false;
    syncButtons();
    setStatus('error', 'Sequência cancelada durante a pausa.', '0.0 s');
    return;
  }

  const r2 = await runProfileWithEngine(p2);
  state.isRunning = false;
  syncButtons();
  setStatus(
    r2.status === 'OK' ? '' : 'error',
    `Comparação concluída: ${p1.id} (${r1.status}) vs. ${p2.id} (${r2.status}).`,
    `${(r1.totalDurationSec + r2.totalDurationSec).toFixed(1)} s`
  );
}

function buildTextSummary() {
  const lines = [
    'TESTAI LAB — RESUMO COMPARATIVO DE PERFIS',
    `Gerado em: ${new Date().toISOString()}`,
    '----------------------------------------------------------------------'
  ];
  for (const r of state.results) {
    lines.push(
      `${r.profileName} | Status: ${r.status} | Med.Total: ↓${r.dl.medianTotalMbps?.toFixed(1) ?? '—'} / ↑${r.ul.medianTotalMbps?.toFixed(1) ?? '—'} Mbps | Med.Sust(>=1MB): ↓${r.dl.medianSustainedMbps?.toFixed(1) ?? '—'} / ↑${r.ul.medianSustainedMbps?.toFixed(1) ?? '—'} Mbps | P90(Ref): ↓${r.dl.p90Mbps?.toFixed(1) ?? '—'} / ↑${r.ul.p90Mbps?.toFixed(1) ?? '—'} Mbps | MaxGap: ${r.maxGapSec.toFixed(2)}s | Tempo: ${r.totalDurationSec.toFixed(1)}s | Amostras: ${r.dl.count}↓/${r.ul.count}↑`
    );
  }
  return lines.join('\n');
}

async function copyOutput(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus('', `${label} copiado para a área de transferência.`);
  } catch {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `testai-lab-${Date.now()}.${label.includes('JSON') ? 'json' : 'txt'}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderProfileCards();
  renderComparisonTable();
  syncButtons();

  document.getElementById('runFinalistsBtn')?.addEventListener('click', runTwoFinalists);

  document.getElementById('cancelRunBtn')?.addEventListener('click', () => {
    if (!state.isRunning) return;
    state.cancelRequested = true;
    try {
      state.activeEngine?.pause?.();
    } catch {
      // noop
    }
  });

  document.getElementById('clearResultsBtn')?.addEventListener('click', () => {
    if (state.isRunning) return;
    state.results = [];
    state.blockCounter = 0;
    renderComparisonTable();
    const logBody = document.getElementById('blockLogBody');
    if (logBody) {
      clearEl(logBody);
      const tr = document.createElement('tr');
      const td = makeEl('td', 'muted', 'Aguardando blocos concluídos...');
      td.colSpan = 7;
      tr.appendChild(td);
      logBody.appendChild(tr);
    }
    syncButtons();
    setStatus('', 'Resultados limpos.', '0.0 s');
  });

  document.getElementById('copyTextBtn')?.addEventListener('click', () => {
    copyOutput(buildTextSummary(), 'Resumo em texto');
  });

  document.getElementById('copyJsonBtn')?.addEventListener('click', () => {
    copyOutput(JSON.stringify({ generatedAt: new Date().toISOString(), results: state.results }, null, 2), 'Resumo JSON');
  });
});
