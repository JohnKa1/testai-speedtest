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

function readCssToken(name, fallback) {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return fallback;
  }
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

function resolveChartPalette() {
  return {
    text1: readCssToken('--text-1', '#F8FAFC'),
    text2: readCssToken('--text-2', '#94A3B8'),
    line: readCssToken('--line', '#1E293B'),
    ok: readCssToken('--ok', '#10B981'),
    seriesDown: readCssToken('--series-down', '#60A5FA'),
    seriesUp: readCssToken('--series-up', '#8B5CF6'),
    seriesDownFill: 'rgba(96, 165, 250, 0.14)',
    seriesUpFill: 'rgba(139, 92, 246, 0.12)'
  };
}

function drawEmptyState(ctx, width, height, message) {
  const palette = resolveChartPalette();
  ctx.fillStyle = palette.text2;
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
  const palette = resolveChartPalette();

  const dl = Array.isArray(downloadPoints) ? downloadPoints : [];
  const ul = Array.isArray(uploadPoints) ? uploadPoints : [];

  if (dl.length === 0 && ul.length === 0) {
    drawEmptyState(ctx, width, height, 'Nenhuma amostra de vazão coletada ainda');
    return;
  }

  const pad = { top: 26, right: 16, bottom: 26, left: 54 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const allValues = [...dl.map((p) => p.mbps), ...ul.map((p) => p.mbps)].filter(isNonNegativeNumber);
  const maxVal = Math.max(10, ...allValues) * 1.12;

  // Rótulo fixo de unidade no topo do eixo Y (sempre em Mbps)
  ctx.fillStyle = palette.text2;
  ctx.font = '600 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('Mbps', pad.left - 6, 11);

  // Grade horizontal
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 1;
  ctx.fillStyle = palette.text2;
  ctx.font = '500 11px "JetBrains Mono", monospace';
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

    ctx.fillText(String(Math.round(labelVal)), pad.left - 6, y);
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

  drawSeries(dl, palette.seriesDown, palette.seriesDownFill);
  drawSeries(ul, palette.seriesUp, palette.seriesUpFill);

  // Legenda superior com marcador colorido e texto em --text-1 (evita violeta em texto pequeno)
  ctx.font = '600 11px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const dlText = `Download (${dl.length} pts)`;
  const ulText = `Upload (${ul.length} pts)`;

  ctx.fillStyle = palette.seriesDown;
  ctx.fillText('●', pad.left, 11);
  const dotW = ctx.measureText('● ').width;
  ctx.fillStyle = palette.text1;
  ctx.fillText(dlText, pad.left + dotW, 11);

  const ulStartX = pad.left + dotW + ctx.measureText(dlText).width + 16;
  ctx.fillStyle = palette.seriesUp;
  ctx.fillText('●', ulStartX, 11);
  ctx.fillStyle = palette.text1;
  ctx.fillText(ulText, ulStartX + dotW, 11);

  ctx.fillStyle = palette.text2;
  ctx.font = '500 11px Inter, sans-serif';
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
  const palette = resolveChartPalette();

  const m = telemetry?.metrics || {};
  const stats = telemetry?.stats || {};

  const categories = [
    {
      label: 'Ocioso',
      median: m.ping?.value ?? null,
      min: stats.unloadedLatency?.min ?? null,
      max: stats.unloadedLatency?.max ?? null,
      color: palette.ok
    },
    {
      label: 'Sob Download',
      median: m.downloadLatency?.value ?? null,
      min: stats.downloadLatency?.min ?? null,
      max: stats.downloadLatency?.max ?? null,
      color: palette.seriesDown
    },
    {
      label: 'Sob Upload',
      median: m.uploadLatency?.value ?? null,
      min: stats.uploadLatency?.min ?? null,
      max: stats.uploadLatency?.max ?? null,
      color: palette.seriesUp
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
  const pad = { top: 38, right: 16, bottom: 28, left: 50 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // Legenda explicativa de barra sólida (Mediana) vs. haste (Mín–Máx)
  const compact = width < 320;
  const barLabel = compact ? 'Mediana' : 'Barra: Mediana (P50)';
  const whiskerLabel = compact ? 'Mín–Máx' : 'Haste: Mín–Máx';

  ctx.save();
  ctx.font = '600 11px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const legendY = 12;
  ctx.fillStyle = palette.seriesDown;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(pad.left, legendY - 4, 10, 8);
  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.text2;
  ctx.fillText(barLabel, pad.left + 15, legendY);

  const barLegendW = ctx.measureText(barLabel).width;
  const whiskerX = pad.left + 15 + barLegendW + 18;
  ctx.strokeStyle = palette.text1;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(whiskerX, legendY - 5);
  ctx.lineTo(whiskerX, legendY + 5);
  ctx.moveTo(whiskerX - 3, legendY - 5);
  ctx.lineTo(whiskerX + 3, legendY - 5);
  ctx.moveTo(whiskerX - 3, legendY + 5);
  ctx.lineTo(whiskerX + 3, legendY + 5);
  ctx.stroke();

  ctx.fillStyle = palette.text2;
  ctx.fillText(whiskerLabel, whiskerX + 8, legendY);
  ctx.restore();

  // Grade
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 1;
  ctx.fillStyle = palette.text2;
  ctx.font = '500 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= 4; i++) {
    const ratio = i / 4;
    const y = pad.top + plotH - ratio * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillText(`${(ratio * maxMs).toFixed(0)} ms`, pad.left - 6, y);
  }

  const slotW = plotW / categories.length;
  const barW = Math.min(44, slotW * 0.42);

  categories.forEach((cat, i) => {
    const centerX = pad.left + slotW * i + slotW / 2;

    if (isNonNegativeNumber(cat.median)) {
      const rawBarH = (cat.median / maxMs) * plotH;
      const barH = cat.median > 0 ? Math.max(2, rawBarH) : 0;
      const barY = pad.top + plotH - barH;

      ctx.fillStyle = cat.color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(centerX - barW / 2, barY, barW, barH);
      ctx.globalAlpha = 1;

      const hasWhisker =
        isNonNegativeNumber(cat.min) && isNonNegativeNumber(cat.max) && cat.max >= cat.min;
      let yMax = barY;

      // Haste de variação real (mín–máx)
      if (hasWhisker) {
        const yMin = pad.top + plotH - (cat.min / maxMs) * plotH;
        yMax = pad.top + plotH - (cat.max / maxMs) * plotH;
        ctx.strokeStyle = palette.text1;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(centerX, yMin);
        ctx.lineTo(centerX, yMax);
        ctx.moveTo(centerX - 5, yMax);
        ctx.lineTo(centerX + 5, yMax);
        ctx.moveTo(centerX - 4, yMin);
        ctx.lineTo(centerX + 4, yMin);
        ctx.stroke();
      }

      const topAnchorY = hasWhisker ? Math.min(barY, yMax) : barY;
      ctx.fillStyle = palette.text1;
      ctx.font = '700 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${cat.median.toFixed(0)} ms`, centerX, Math.max(pad.top + 4, topAnchorY - 6));
    } else {
      ctx.fillStyle = palette.text2;
      ctx.font = '600 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N/D', centerX, pad.top + plotH - 12);
    }

    ctx.fillStyle = palette.text2;
    ctx.font = '600 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
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
  const palette = resolveChartPalette();

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

  const pad = { top: 26, right: 16, bottom: 24, left: 54 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  ctx.fillStyle = palette.text2;
  ctx.font = '600 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('Mbps', pad.left - 6, 11);

  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 1;
  ctx.fillStyle = palette.text2;
  ctx.font = '500 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= 3; i++) {
    const ratio = i / 3;
    const y = pad.top + plotH - ratio * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(ratio * maxVal)), pad.left - 6, y);
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

  drawHistoryLine((r) => r.downloadMbps, palette.seriesDown);
  drawHistoryLine((r) => r.uploadMbps, palette.seriesUp);

  ctx.font = '600 11px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = palette.seriesDown;
  ctx.fillText('●', pad.left, 11);
  const dotW = ctx.measureText('● ').width;
  ctx.fillStyle = palette.text1;
  ctx.fillText('Download (Mbps)', pad.left + dotW, 11);

  const ulStartX = pad.left + dotW + ctx.measureText('Download (Mbps)').width + 16;
  ctx.fillStyle = palette.seriesUp;
  ctx.fillText('●', ulStartX, 11);
  ctx.fillStyle = palette.text1;
  ctx.fillText('Upload (Mbps)', ulStartX + dotW, 11);
}