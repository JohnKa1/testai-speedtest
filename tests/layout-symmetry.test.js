import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();

function readUtf8(...segments) {
  return fs.readFileSync(path.join(ROOT_DIR, ...segments), 'utf8');
}

function extractFooterBlock(html) {
  const match = html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/);
  return match ? match[1] : '';
}

function extractHeaderBlock(html) {
  const match = html.match(/<header\b[^>]*class="topbar"[^>]*>([\s\S]*?)<\/header>/);
  return match ? match[1] : '';
}

test('botão PWA #installAppBtn foi movido do cabeçalho para o rodapé preservando ID e classes', () => {
  const html = readUtf8('index.html');
  const headerHtml = extractHeaderBlock(html);
  const footerHtml = extractFooterBlock(html);

  assert.ok(headerHtml.length > 0, 'index.html deve conter <header class="topbar">');
  assert.ok(footerHtml.length > 0, 'index.html deve conter <footer>');

  assert.equal(
    headerHtml.includes('id="installAppBtn"'),
    false,
    '#installAppBtn não deve permanecer dentro de .topbar'
  );
  assert.match(
    footerHtml,
    /class="[^"]*\bbtn-secondary\b[^"]*\bhidden\b[^"]*"\s+id="installAppBtn"/,
    '<footer> deve conter #installAppBtn mantendo class="btn-secondary hidden"'
  );

  const simpleCss = readUtf8('src', 'styles', 'simple-mode.css');
  assert.ok(simpleCss.includes('body.is-embed footer'));
});

test('padronização dos botões do medidor: altura >= 48px e border-radius var(--r-item) simétricos', () => {
  const controlsCss = readUtf8('src', 'styles', 'controls.css');
  const simpleCss = readUtf8('src', 'styles', 'simple-mode.css');

  assert.match(
    controlsCss,
    /\.btn-hero\s*\{[^}]*min-height:\s*48px;[^}]*border-radius:\s*var\(--r-item\);/s,
    '.btn-hero deve padronizar min-height: 48px e border-radius: var(--r-item)'
  );
  assert.match(
    simpleCss,
    /\.simple-cta-row\s+\.btn-primary,\s*\.simple-cta-row\s+\.btn-secondary\s*\{[^}]*min-height:\s*48px;[^}]*border-radius:\s*var\(--r-item\);/s,
    '.simple-cta-row deve padronizar altura 48px e border-radius: var(--r-item) entre botão principal e secundários'
  );
});

test('cabeçalho em linha única no desktop e controles de veredito com aparência clicável inequívoca', () => {
  const responsiveCss = readUtf8('src', 'styles', 'responsive.css');
  const controlsCss = readUtf8('src', 'styles', 'controls.css');
  const simpleCss = readUtf8('src', 'styles', 'simple-mode.css');

  assert.match(
    responsiveCss,
    /\.topbar\s*\{[^}]*flex-direction:\s*row;[^}]*justify-content:\s*space-between;[^}]*align-items:\s*center;/s
  );
  assert.match(responsiveCss, /\.topbar-right\s*\{[^}]*flex-wrap:\s*nowrap;/s);
  assert.match(responsiveCss, /\.status-pills\s*\{[^}]*flex-wrap:\s*nowrap;/s);

  assert.match(
    controlsCss,
    /\.btn-link-toggle\s*\{[^}]*background:\s*var\(--surface-2\);[^}]*border:\s*1px solid var\(--line-strong\);[^}]*color:\s*var\(--info\);/s
  );
  assert.match(controlsCss, /\.btn-link-toggle::after\s*\{[^}]*content:\s*'→'/s);
  assert.match(
    simpleCss,
    /\.simple-verdict-card\s+\.btn-secondary\s*\{[^}]*background:\s*var\(--surface-2\);[^}]*color:\s*var\(--info\);/s
  );
  assert.match(simpleCss, /\.simple-verdict-card\s+\.btn-secondary::after\s*\{[^}]*content:\s*'→'/s);
});

test('Modo Avançado: align-items start no grid principal e grid simétrico para Gaming', () => {
  const advancedCss = readUtf8('src', 'styles', 'advanced-mode.css');
  const responsiveCss = readUtf8('src', 'styles', 'responsive.css');

  assert.match(advancedCss, /\.telemetry-grid\s*\{[^}]*align-items:\s*start;/s);
  assert.match(
    responsiveCss,
    /@media\s*\(min-width:\s*1025px\)\s*\{[^}]*\.telemetry-grid\s*\{[^}]*align-items:\s*start;/s
  );
  assert.equal(
    /\.telemetry-grid\s*\{[^}]*align-items:\s*stretch;/s.test(responsiveCss),
    false,
    '.telemetry-grid não deve esticar o painel esquerdo com align-items: stretch'
  );

  assert.match(
    responsiveCss,
    /\.gaming-pillars-grid,\s*\.gaming-genres-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s
  );
  assert.match(
    responsiveCss,
    /\.gaming-genre:last-child:nth-child\(odd\)\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/s
  );
});

test('responsivo 360px e conformidade estrita de tokens CSS sem hex/rgba hardcoded', () => {
  const baseCss = readUtf8('src', 'styles', 'base.css');
  const controlsCss = readUtf8('src', 'styles', 'controls.css');
  const simpleCss = readUtf8('src', 'styles', 'simple-mode.css');
  const advancedCss = readUtf8('src', 'styles', 'advanced-mode.css');
  const responsiveCss = readUtf8('src', 'styles', 'responsive.css');

  assert.match(responsiveCss, /@media\s*\(max-width:\s*480px\)/);
  assert.match(
    responsiveCss,
    /@media\s*\(max-width:\s*480px\)[\s\S]*\.simple-cta-row\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/
  );
  assert.match(
    responsiveCss,
    /@media\s*\(max-width:\s*480px\)[\s\S]*body\.is-embed\s+\.app-shell/
  );

  for (const [file, css] of [
    ['base.css', baseCss],
    ['controls.css', controlsCss],
    ['simple-mode.css', simpleCss],
    ['advanced-mode.css', advancedCss],
    ['responsive.css', responsiveCss]
  ]) {
    assert.equal(
      /#[0-9a-fA-F]{3,8}|rgba?\(/.test(css),
      false,
      `${file} não deve conter hexadecimais ou rgba() fora de tokens.css`
    );
  }
});
