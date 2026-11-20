/**
 * Renderização de gráficos técnicos em Canvas HD utilizando exclusivamente
 * dados reais coletados pelo motor de medição. Nunca inventa pontos sintéticos.
 */

import { isNonNegativeNumber } from '../utils/validators.js';

function prepareCanvas(canvas) {
  if (!canvas) return null;
  const parent = canvas.parentElement;
  const rect = parent ? parent.getBoundingClientRect() : { width: 420, height: 180 };
  const width = Math.max(240, Math.floor(rect.width));
  const height = Math.max(150, Math.floor(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  return { ctx, width, height };
}

function drawEmptyState(ctx, width, height, message) {
  ctx.fillStyle = '#8ba0bd';
  ctx.font = '500 12px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
}

/**
 * Gráfico 1: Curva real de velocidade ao longo do teste (Download e Upload).
 */
export function renderThroughputChart(canvas, downloadPoints = [], uploadPoints = []) {
  const setup = prepareCanvas(canvas);
  if (!setup) return;
  const { ctx, width, height } = setup;

  const dl = Array.isArray(downloadPoints) ? downloadPoints : [];
  const ul = Array.isArray(uploadPoints) ? uploadPoints : [];

  if (dl.length === 0 && ul.length === 0) {
    drawEmptyState(ctx, width, height, 'Nenhuma amostra de vazão coletada ainda');
    return;
  }

  const pad = { top: 24, right: 16, bottom: 26, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const allValues = [...dl.map((p) => p.mbps), ...ul.map((p) => p.mbps)].filter(isNonNegativeNumber);
  const maxVal = Math.max(10, ...allValues) * 1.12;

  // Grade horizontal
  ctx.strokeStyle = 'rgba(139, 160, 189, 0.14)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#8ba0bd';
  ctx.font = '400 10px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const ratio = i / gridSteps;
    const y = pad.top + plotH - ratio * plotH;
    const labelVal = ratio * maxVal;

    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();

    const formatted =
      labelVal >= 1000 ? `${(labelVal / 1000).toFixed(1)}G` : `${labelVal.toFixed(0)}M`;
    ctx.fillText(formatted, pad.left - 6, y);
  }

  const drawSeries = (points, strokeColor, fillColor) => {
    if (points.length === 0) return;

    const coords = points.map((pt, idx) => {
      const xRatio = points.length === 1 ? 0.5 : idx / (points.length - 1);
      const yRatio = Math.min(1, Math.max(0, pt.mbps / maxVal));
      return {
        x: pad.left + xRatio * plotW,
        y: pad.top + plotH - yRatio * plotH
      };
    });

    if (coords.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(coords[0].x, pad.top + plotH);
      coords.forEach((c) => ctx.lineTo(c.x, c.y));
      ctx.lineTo(coords[coords.length - 1].x, pad.top + plotH);
      ctx.closePath();
      ctx.fillStyle = fillColor;
      ctx.fill();

      ctx.beginPath();
      coords.forEach((c, idx) => {
        if (idx === 0) ctx.moveTo(c.x, c.y);
        else ctx.lineTo(c.x, c.y);
      });
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.fillStyle = strokeColor;
    coords.forEach((c) => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  drawSeries(dl, '#00d4ff', 'rgba(0, 212, 255, 0.12)');
  drawSeries(ul, '#00e676', 'rgba(0, 230, 118, 0.10)');

  // Legenda superior
  ctx.font = '600 10px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#00d4ff';
  ctx.fillText(`● Download (${dl.length} pts)`, pad.left, 11);
  ctx.fillStyle = '#00e676';
  ctx.fillText(`● Upload (${ul.length} pts)`, pad.left + 125, 11);

  ctx.fillStyle = '#8ba0bd';
  ctx.font = '400 10px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Sequência real de amostras coletadas (Mbps)', pad.left + plotW / 2, height - 8);
}

/**
 * Gráfico 2: Comparação de Latência Ociosa vs. Sob Download vs. Sob Upload (P50 + faixa mín/máx real).
 */
export function renderLatencyComparisonChart(canvas, telemetry) {
  const setup = prepareCanvas(canvas);
  if (!setup) return;
  const { ctx, width, height } = setup;

  const m = telemetry?.metrics || {};
  const stats = telemetry?.stats || {};

  const categories = [
    {
      label: 'Ocioso',
      median: m.ping?.value ?? null,
      min: stats.unloadedLatency?.min ?? null,
      max: stats.unloadedLatency?.max ?? null,
      color: '#00e676'
    },
    {
      label: 'Sob Download',
      median: m.downloadLatency?.value ?? null,
      min: stats.downloadLatency?.min ?? null,
      max: stats.downloadLatency?.max ?? null,
      color: '#00d4ff'
    },
    {
      label: 'Sob Upload',
      median: m.uploadLatency?.value ?? null,
      min: stats.uploadLatency?.min ?? null,
      max: stats.uploadLatency?.max ?? null,
      color: '#f5a623'
    }
  ];

  const validValues = categories
    .flatMap((c) => [c.median, c.max])
    .filter(isNonNegativeNumber);

  if (validValues.length === 0) {
    drawEmptyState(ctx, width, height, 'Aguardando medições de RTT ocioso e sob carga');
    return;
  }

  const maxMs = Math.max(20, ...validValues) * 1.18;
  const pad = { top: 20, right: 16, bottom: 28, left: 46 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // Grade
  ctx.strokeStyle = 'rgba(139, 160, 189, 0.14)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#8ba0bd';
  ctx.font = '400 10px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= 4; i++) {
    const ratio = i / 4;
    const y = pad.top + plotH - ratio * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillText(`${(ratio * maxMs).toFixed(0)}ms`, pad.left - 6, y);
  }

  const slotW = plotW / categories.length;
  const barW = Math.min(44, slotW * 0.42);

  categories.forEach((cat, i) => {
    const centerX = pad.left + slotW * i + slotW / 2;

    if (isNonNegativeNumber(cat.median)) {
      const barH = (cat.median / maxMs) * plotH;
      const barY = pad.top + plotH - barH;

      ctx.fillStyle = cat.color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(centerX - barW / 2, barY, barW, barH);
      ctx.globalAlpha = 1;

      // Haste de variação real (mín–máx) se disponível
      if (isNonNegativeNumber(cat.min) && isNonNegativeNumber(cat.max) && cat.max >= cat.min) {
        const yMin = pad.top + plotH - (cat.min / maxMs) * plotH;
        const yMax = pad.top + plotH - (cat.max / maxMs) * plotH;
        ctx.strokeStyle = '#e8f0fe';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(centerX, yMin);
        ctx.lineTo(centerX, yMax);
        ctx.moveTo(centerX - 5, yMax);
        ctx.lineTo(centerX + 5, yMax);
        ctx.stroke();
      }

      ctx.fillStyle = '#e8f0fe';
      ctx.font = '700 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${cat.median.toFixed(0)} ms`, centerX, Math.max(12, barY - 8));
    } else {
      ctx.fillStyle = '#8ba0bd';
      ctx.font = '500 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('N/D', centerX, pad.top + plotH - 12);
    }

    ctx.fillStyle = '#8ba0bd';
    ctx.font = '600 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(cat.label, centerX, height - 10);
  });
}

/**
 * Gráfico 3: Evolução histórica das execuções salvas (Download e Upload).
 */
export function renderHistoryChart(canvas, records = []) {
  const setup = prepareCanvas(canvas);
  if (!setup) return;
  const { ctx, width, height } = setup;

  const ordered = [...records].reverse().slice(-15);
  if (ordered.length < 2) {
    drawEmptyState(
      ctx,
      width,
      height,
      'Execute pelo menos 2 testes para visualizar a evolução histórica'
    );
    return;
  }

  const dlVals = ordered.map((r) => r.downloadMbps).filter(isNonNegativeNumber);
  const ulVals = ordered.map((r) => r.uploadMbps).filter(isNonNegativeNumber);
  const maxVal = Math.max(10, ...dlVals, ...ulVals) * 1.15;

  const pad = { top: 24, right: 16, bottom: 24, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  ctx.strokeStyle = 'rgba(139, 160, 189, 0.14)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#8ba0bd';
  ctx.font = '400 10px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= 3; i++) {
    const ratio = i / 3;
    const y = pad.top + plotH - ratio * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillText(`${(ratio * maxVal).toFixed(0)}M`, pad.left - 6, y);
  }

  const drawHistoryLine = (getter, color) => {
    ctx.beginPath();
    let started = false;
    ordered.forEach((rec, idx) => {
      const val = getter(rec);
      if (!isNonNegativeNumber(val)) return;
      const x = pad.left + (idx / (ordered.length - 1)) * plotW;
      const y = pad.top + plotH - (val / maxVal) * plotH;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    ordered.forEach((rec, idx) => {
      const val = getter(rec);
      if (!isNonNegativeNumber(val)) return;
      const x = pad.left + (idx / (ordered.length - 1)) * plotW;
      const y = pad.top + plotH - (val / maxVal) * plotH;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  drawHistoryLine((r) => r.downloadMbps, '#00d4ff');
  drawHistoryLine((r) => r.uploadMbps, '#00e676');

  ctx.font = '600 10px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#00d4ff';
  ctx.fillText('● Download (Mbps)', pad.left, 11);
  ctx.fillStyle = '#00e676';
  ctx.fillText('● Upload (Mbps)', pad.left + 120, 11);
}