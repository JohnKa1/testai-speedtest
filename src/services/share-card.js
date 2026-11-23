/**
 * Gerador de card visual (PNG via Canvas 2D nativo) e compartilhamento
 * para WhatsApp / Web Share API com fallback para download direto em desktop.
 */

import { DEFAULT_RUNTIME_CONFIG } from './runtime-config.js';
import { evaluateSimpleStability } from '../diagnostics/capability-advisor.js';
import {
  formatDeltaMs,
  formatMetricWithUnit,
  resolvePrimaryAndPeakSpeed
} from '../utils/formatters.js';
import { isNonNegativeNumber, METRIC_STATUS } from '../utils/validators.js';

function padTwo(value) {
  return String(value).padStart(2, '0');
}

function resolveResultDate(result) {
  const raw = result?.timestamp || Date.now();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Gera o nome de arquivo padronizado para download/compartilhamento do PNG.
 *
 * @param {Partial<import('../types.js').SpeedTestResult> | null | undefined} result
 * @returns {string}
 */
export function buildShareFilename(result) {
  const d = resolveResultDate(result);
  const yyyy = d.getFullYear();
  const mm = padTwo(d.getMonth() + 1);
  const dd = padTwo(d.getDate());
  const hh = padTwo(d.getHours());
  const min = padTwo(d.getMinutes());
  return `testai-resultado-${yyyy}${mm}${dd}-${hh}${min}.png`;
}

/**
 * Extrai e normaliza métricas e textos exibidos tanto no resumo textual
 * quanto no card Canvas 2D, evitando divergência entre ambos.
 *
 * @param {any} result
 * @param {any} [runtimeConfig]
 */
function extractShareCardData(result, runtimeConfig = DEFAULT_RUNTIME_CONFIG) {
  const cfg = runtimeConfig || DEFAULT_RUNTIME_CONFIG;
  const ispName =
    typeof cfg.ispName === 'string' && cfg.ispName.trim().length > 0
      ? cfg.ispName.trim()
      : DEFAULT_RUNTIME_CONFIG.ispName;
  const serverLabel =
    typeof cfg.serverLabel === 'string' && cfg.serverLabel.trim().length > 0
      ? cfg.serverLabel.trim()
      : DEFAULT_RUNTIME_CONFIG.serverLabel;

  const measurementMode =
    (result?.measurementMode || cfg.measurementMode) === 'commercial'
      ? 'commercial'
      : 'sustained';
  const isCommercial = measurementMode === 'commercial';

  const m = result?.metrics || {};
  const dlInfo = resolvePrimaryAndPeakSpeed(
    result?.series?.downloadPoints || [],
    m.download,
    result?.stats?.download || null,
    { measurementMode }
  );
  const ulInfo = resolvePrimaryAndPeakSpeed(
    result?.series?.uploadPoints || [],
    m.upload,
    result?.stats?.upload || null,
    { measurementMode }
  );

  const dlMeasured =
    dlInfo.status === METRIC_STATUS.MEASURED && isNonNegativeNumber(dlInfo.primary);
  const ulMeasured =
    ulInfo.status === METRIC_STATUS.MEASURED && isNonNegativeNumber(ulInfo.primary);

  const dlPrimaryText = formatMetricWithUnit(dlInfo.primary, 'Mbps', 1, dlInfo.status);
  const ulPrimaryText = formatMetricWithUnit(ulInfo.primary, 'Mbps', 1, ulInfo.status);

  const dlNumberText = dlMeasured ? Number(dlInfo.primary).toFixed(1) : dlPrimaryText;
  const ulNumberText = ulMeasured ? Number(ulInfo.primary).toFixed(1) : ulPrimaryText;

  let dlSubText = isCommercial ? 'Modo P90' : 'Média sustentada';
  if (isCommercial) {
    if (isNonNegativeNumber(dlInfo.sustained)) {
      dlSubText = `Sustentado: ${dlInfo.sustained.toFixed(1)} Mbps`;
    } else if (isNonNegativeNumber(dlInfo.peak)) {
      dlSubText = `Pico: ${dlInfo.peak.toFixed(1)} Mbps`;
    }
  } else if (isNonNegativeNumber(dlInfo.peak)) {
    dlSubText = `Pico: ${dlInfo.peak.toFixed(1)} Mbps`;
  }

  let ulSubText = isCommercial ? 'Modo P90' : 'Média sustentada';
  if (isCommercial) {
    if (isNonNegativeNumber(ulInfo.sustained)) {
      ulSubText = `Sustentado: ${ulInfo.sustained.toFixed(1)} Mbps`;
    } else if (isNonNegativeNumber(ulInfo.peak)) {
      ulSubText = `Pico: ${ulInfo.peak.toFixed(1)} Mbps`;
    }
  } else if (isNonNegativeNumber(ulInfo.peak)) {
    ulSubText = `Pico: ${ulInfo.peak.toFixed(1)} Mbps`;
  }

  const pingText = formatMetricWithUnit(
    m.ping?.value,
    'ms',
    0,
    m.ping?.status || METRIC_STATUS.UNAVAILABLE
  );
  const jitterText = formatMetricWithUnit(
    m.jitter?.value,
    'ms',
    1,
    m.jitter?.status || METRIC_STATUS.UNAVAILABLE
  );

  const dlDelta =
    m.downloadLatencyDelta?.status === METRIC_STATUS.MEASURED
      ? m.downloadLatencyDelta.value
      : null;
  const ulDelta =
    m.uploadLatencyDelta?.status === METRIC_STATUS.MEASURED
      ? m.uploadLatencyDelta.value
      : null;
  const validDeltas = [dlDelta, ulDelta].filter(isNonNegativeNumber);
  const maxDelta = validDeltas.length > 0 ? Math.max(...validDeltas) : null;
  const deltaText = formatDeltaMs(maxDelta);

  const stability = evaluateSimpleStability(result, Boolean(result?.incomplete));
  const d = resolveResultDate(result);
  const dateTimeLabel = `${padTwo(d.getDate())}/${padTwo(d.getMonth() + 1)}/${d.getFullYear()} ${padTwo(d.getHours())}:${padTwo(d.getMinutes())}`;

  return {
    ispName,
    serverLabel,
    isCommercial,
    dlMeasured,
    ulMeasured,
    dlNumberText,
    ulNumberText,
    dlPrimaryText,
    ulPrimaryText,
    dlSubText,
    ulSubText,
    pingText,
    jitterText,
    deltaText,
    stabilityLabel: stability.label,
    stabilityTone: stability.tone,
    dateTimeLabel
  };
}

/**
 * Gera resumo curto em texto puro para acompanhar a imagem no compartilhamento.
 *
 * @param {any} result
 * @param {any} [runtimeConfig]
 * @returns {string}
 */
export function buildShareSummaryText(result, runtimeConfig = DEFAULT_RUNTIME_CONFIG) {
  const data = extractShareCardData(result, runtimeConfig);
  const headerBrand =
    data.ispName !== DEFAULT_RUNTIME_CONFIG.ispName
      ? `${data.ispName} • TestAi`
      : 'TestAi — Medidor de Velocidade';
  const modeLabel = data.isCommercial ? 'Comercial (P90)' : 'Sustentado (P50)';

  return [
    headerBrand,
    `Servidor: ${data.serverLabel} (${data.dateTimeLabel})`,
    `Modo: ${modeLabel}`,
    `Download: ${data.dlPrimaryText} (${data.dlSubText})`,
    `Upload: ${data.ulPrimaryText} (${data.ulSubText})`,
    `Ping: ${data.pingText} | Jitter: ${data.jitterText}`,
    `Latência sob carga: ${data.deltaText} | Estabilidade: ${data.stabilityLabel}`
  ].join('\n');
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function resolveToneColor(tone) {
  if (tone === 'good') return '#10B981';
  if (tone === 'warning') return '#F59E0B';
  if (tone === 'danger') return '#EF4444';
  return '#F8FAFC';
}

function drawHeroMetricCard(ctx, opts) {
  const { x, y, width, height, title, numberText, showUnit, subText, accentColor, borderColor } =
    opts;

  drawRoundedRect(ctx, x, y, width, height, 28);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = borderColor;
  ctx.stroke();

  // Barra superior de destaque
  drawRoundedRect(ctx, x + 28, y + 24, 56, 6, 3);
  ctx.fillStyle = accentColor;
  ctx.fill();

  ctx.textAlign = 'left';
  ctx.fillStyle = accentColor;
  ctx.font = '700 22px Inter, system-ui, sans-serif';
  ctx.fillText(title, x + 28, y + 70);

  ctx.fillStyle = '#F8FAFC';
  ctx.font = '800 84px "JetBrains Mono", monospace';
  ctx.fillText(numberText, x + 28, y + 178);

  if (showUnit) {
    ctx.fillStyle = '#94A3B8';
    ctx.font = '600 26px Inter, system-ui, sans-serif';
    ctx.fillText('Mbps', x + 28, y + 224);
  }

  ctx.fillStyle = '#CBD5E1';
  ctx.font = '500 22px Inter, system-ui, sans-serif';
  ctx.fillText(subText, x + 28, y + height - 34);
}

function drawQualityCard(ctx, opts) {
  const { x, y, width, height, label, valueText, valueColor = '#F8FAFC' } = opts;

  drawRoundedRect(ctx, x, y, width, height, 22);
  ctx.fillStyle = 'rgba(30, 41, 59, 0.68)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = '#94A3B8';
  ctx.font = '600 20px Inter, system-ui, sans-serif';
  ctx.fillText(label, x + 28, y + 52);

  ctx.fillStyle = valueColor;
  ctx.font = '700 40px "JetBrains Mono", monospace';
  ctx.fillText(valueText, x + 28, y + 114);
}

/**
 * Renderiza o card visual do resultado em PNG via Canvas 2D nativo.
 *
 * @param {any} result
 * @param {any} [runtimeConfig]
 * @param {{ createCanvas?: (w: number, h: number) => any, width?: number, height?: number }} [deps]
 * @returns {Promise<Blob>}
 */
export async function renderShareCardBlob(
  result,
  runtimeConfig = DEFAULT_RUNTIME_CONFIG,
  deps = {}
) {
  const width = deps.width ?? 1080;
  const height = deps.height ?? 1080;
  const canvas =
    typeof deps.createCanvas === 'function'
      ? deps.createCanvas(width, height)
      : document.createElement('canvas');

  if (!canvas) {
    throw new Error('Elemento Canvas indisponível para gerar card.');
  }

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Contexto Canvas 2D indisponível.');
  }

  const data = extractShareCardData(result, runtimeConfig);

  // Fundo escuro padrão TestAi com brilho ambiente sutil
  ctx.fillStyle = '#0B0F19';
  ctx.fillRect(0, 0, width, height);

  if (typeof ctx.createRadialGradient === 'function') {
    const cyanGlow = ctx.createRadialGradient(180, 140, 20, 180, 140, 560);
    cyanGlow.addColorStop(0, 'rgba(0, 229, 255, 0.16)');
    cyanGlow.addColorStop(1, 'rgba(11, 15, 25, 0)');
    ctx.fillStyle = cyanGlow;
    ctx.fillRect(0, 0, width, height);

    const amberGlow = ctx.createRadialGradient(920, 260, 20, 920, 260, 500);
    amberGlow.addColorStop(0, 'rgba(245, 158, 11, 0.11)');
    amberGlow.addColorStop(1, 'rgba(11, 15, 25, 0)');
    ctx.fillStyle = amberGlow;
    ctx.fillRect(0, 0, width, height);
  }

  // Cabeçalho: provedor, servidor e data/hora
  const pad = 64;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#00E5FF';
  ctx.font = '700 20px Inter, system-ui, sans-serif';
  ctx.fillText('RELATÓRIO DE VELOCIDADE', pad, 92);

  ctx.fillStyle = '#F8FAFC';
  ctx.font = '800 44px Inter, system-ui, sans-serif';
  ctx.fillText(data.ispName, pad, 148);

  ctx.fillStyle = '#94A3B8';
  ctx.font = '500 24px Inter, system-ui, sans-serif';
  ctx.fillText(`Servidor: ${data.serverLabel}`, pad, 188);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#CBD5E1';
  ctx.font = '600 22px "JetBrains Mono", monospace';
  ctx.fillText(data.dateTimeLabel, width - pad, 148);

  ctx.fillStyle = data.isCommercial ? '#00E5FF' : '#94A3B8';
  ctx.font = '600 18px Inter, system-ui, sans-serif';
  ctx.fillText(data.isCommercial ? 'MODO COMERCIAL · P90' : 'MODO SUSTENTADO · P50', width - pad, 184);

  // Cartões principais: Download e Upload
  const heroY = 232;
  const heroH = 326;
  const heroW = 460;
  const heroGap = 32;

  drawHeroMetricCard(ctx, {
    x: pad,
    y: heroY,
    width: heroW,
    height: heroH,
    title: '↓ DOWNLOAD',
    numberText: data.dlNumberText,
    showUnit: data.dlMeasured,
    subText: data.dlSubText,
    accentColor: '#00E5FF',
    borderColor: 'rgba(0, 229, 255, 0.36)'
  });

  drawHeroMetricCard(ctx, {
    x: pad + heroW + heroGap,
    y: heroY,
    width: heroW,
    height: heroH,
    title: '↑ UPLOAD',
    numberText: data.ulNumberText,
    showUnit: data.ulMeasured,
    subText: data.ulSubText,
    accentColor: '#F59E0B',
    borderColor: 'rgba(245, 158, 11, 0.36)'
  });

  // Grid de qualidade 2x2
  const gridY = 594;
  const cardW = 462;
  const cardH = 152;
  const colGap = 28;
  const rowGap = 24;

  drawQualityCard(ctx, {
    x: pad,
    y: gridY,
    width: cardW,
    height: cardH,
    label: 'PING EM REPOUSO',
    valueText: data.pingText
  });

  drawQualityCard(ctx, {
    x: pad + cardW + colGap,
    y: gridY,
    width: cardW,
    height: cardH,
    label: 'JITTER',
    valueText: data.jitterText
  });

  drawQualityCard(ctx, {
    x: pad,
    y: gridY + cardH + rowGap,
    width: cardW,
    height: cardH,
    label: 'LATÊNCIA SOB CARGA',
    valueText: data.deltaText
  });

  drawQualityCard(ctx, {
    x: pad + cardW + colGap,
    y: gridY + cardH + rowGap,
    width: cardW,
    height: cardH,
    label: 'ESTABILIDADE',
    valueText: data.stabilityLabel,
    valueColor: resolveToneColor(data.stabilityTone)
  });

  // Rodapé discreto
  const footerLineY = 958;
  ctx.fillStyle = 'rgba(148, 163, 184, 0.22)';
  ctx.fillRect(pad, footerLineY, width - pad * 2, 1);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#94A3B8';
  ctx.font = '600 22px Inter, system-ui, sans-serif';
  const footerLeft =
    data.ispName !== DEFAULT_RUNTIME_CONFIG.ispName
      ? `${data.ispName} • Tecnologia TestAi`
      : 'TestAi — Diagnóstico Inteligente de Internet';
  ctx.fillText(footerLeft, pad, 1008);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#38BDF8';
  ctx.font = '600 20px "JetBrains Mono", monospace';
  ctx.fillText('PWA · Medição em tempo real', width - pad, 1008);

  if (typeof canvas.toBlob === 'function') {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Falha ao converter o card Canvas para PNG.'));
        }
      }, 'image/png');
    });
  }

  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: 'image/png' });
  }

  throw new Error('Canvas atual não suporta exportação em Blob PNG.');
}

/**
 * Compartilha o card visual via Web Share API (com arquivo PNG) no mobile
 * ou aciona download direto do PNG como fallback em desktop.
 *
 * @param {any} result
 * @param {any} [runtimeConfig]
 * @param {{
 *   navigatorObj?: any,
 *   doc?: any,
 *   urlApi?: any,
 *   FileCtor?: any,
 *   renderBlob?: typeof renderShareCardBlob,
 *   createCanvas?: (w: number, h: number) => any
 * }} [deps]
 * @returns {Promise<{ status: 'shared' | 'downloaded' | 'cancelled', filename: string, text: string, blob: Blob }>}
 */
export async function shareTestResult(
  result,
  runtimeConfig = DEFAULT_RUNTIME_CONFIG,
  deps = {}
) {
  const navigatorObj = deps.navigatorObj ?? globalThis.navigator;
  const doc = deps.doc ?? globalThis.document;
  const urlApi = deps.urlApi ?? globalThis.URL;
  const FileCtor = deps.FileCtor ?? globalThis.File;
  const renderBlob = deps.renderBlob ?? renderShareCardBlob;

  const filename = buildShareFilename(result);
  const text = buildShareSummaryText(result, runtimeConfig);
  const ispName =
    typeof runtimeConfig?.ispName === 'string' && runtimeConfig.ispName.trim().length > 0
      ? runtimeConfig.ispName.trim()
      : DEFAULT_RUNTIME_CONFIG.ispName;
  const title =
    ispName !== DEFAULT_RUNTIME_CONFIG.ispName
      ? `Resultado de Velocidade — ${ispName}`
      : 'Resultado de Velocidade — TestAi';

  const blob = await renderBlob(result, runtimeConfig, { createCanvas: deps.createCanvas });

  const supportsWebShare =
    typeof FileCtor === 'function' &&
    typeof navigatorObj?.canShare === 'function' &&
    typeof navigatorObj?.share === 'function';

  if (supportsWebShare) {
    try {
      const file = new FileCtor([blob], filename, { type: 'image/png' });
      if (navigatorObj.canShare({ files: [file] })) {
        await navigatorObj.share({ files: [file], title, text });
        return { status: 'shared', filename, text, blob };
      }
    } catch (err) {
      if (err && typeof err === 'object' && /** @type {any} */ (err).name === 'AbortError') {
        return { status: 'cancelled', filename, text, blob };
      }
      // Outras falhas de Web Share seguem para o download automático do PNG
    }
  }

  if (
    !doc ||
    typeof doc.createElement !== 'function' ||
    !urlApi ||
    typeof urlApi.createObjectURL !== 'function'
  ) {
    throw new Error('Ambiente sem suporte para download do card PNG.');
  }

  const objectUrl = urlApi.createObjectURL(blob);
  try {
    const anchor = doc.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    if (anchor.style) {
      anchor.style.display = 'none';
    }
    if (doc.body && typeof doc.body.appendChild === 'function') {
      doc.body.appendChild(anchor);
    }
    if (typeof anchor.click === 'function') {
      anchor.click();
    }
    if (typeof anchor.remove === 'function') {
      anchor.remove();
    } else if (doc.body && typeof doc.body.removeChild === 'function') {
      doc.body.removeChild(anchor);
    }
  } finally {
    if (typeof urlApi.revokeObjectURL === 'function') {
      urlApi.revokeObjectURL(objectUrl);
    }
  }

  return { status: 'downloaded', filename, text, blob };
}
