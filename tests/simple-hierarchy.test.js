import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { renderRecentHistoryPanel } from '../src/ui/insights-view.js';

const ROOT_DIR = process.cwd();

function readUtf8(...segments) {
  return fs.readFileSync(path.join(ROOT_DIR, ...segments), 'utf8');
}

function createDomNode(tag, id = '') {
  const classSet = new Set();
  const node = {
    tagName: tag,
    id,
    textContent: '',
    disabled: false,
    children: [],
    get firstChild() {
      return this.children[0] || null;
    },
    set className(val) {
      classSet.clear();
      String(val || '')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classSet.add(c));
    },
    get className() {
      return [...classSet].join(' ');
    },
    classList: {
      add: (...items) => items.forEach((c) => classSet.add(c)),
      remove: (...items) => items.forEach((c) => classSet.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classSet.has(c)) classSet.delete(c);
          else classSet.add(c);
        } else if (force) {
          classSet.add(c);
        } else {
          classSet.delete(c);
        }
      },
      contains: (c) => classSet.has(c)
    },
    setAttribute() {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
      return child;
    }
  };
  return node;
}

test('hierarquia visual em 3 níveis: hero mantém .glass e blocos Nível 2 ficam visíveis sem <details>', () => {
  const html = readUtf8('index.html');

  // Nível 1: Hero principal mantém destaque .glass
  assert.match(html, /class="card glass simple-hero-card"/);

  // Nível 2: Veredito e "Pronto para o seu dia a dia?" usam surface-level-2 (sem .glass)
  assert.match(html, /class="card surface-level-2 simple-verdict-card hidden"\s+id="simpleVerdictCard"/);
  assert.match(html, /class="card surface-level-2 usage-verdict-section hidden"\s+id="usageVerdictSection"/);

  // #usageVerdictSection e #simpleVerdictCard aparecem antes do primeiro <details>
  const verdictIdx = html.indexOf('id="simpleVerdictCard"');
  const usageIdx = html.indexOf('id="usageVerdictSection"');
  const firstDetailsIdx = html.indexOf('<details');
  assert.ok(verdictIdx > 0 && usageIdx > verdictIdx && firstDetailsIdx > usageIdx);
  assert.ok(html.includes('Pronto para o seu dia a dia?'));
});

test('divulgação progressiva: 3 blocos secundários recolhidos em <details> nativos fechados por padrão', () => {
  const html = readUtf8('index.html');

  const specs = [
    {
      detailsId: 'moreUsesDisclosure',
      summaryLabel: 'Ver mais usos',
      innerMarker: 'class="capabilities-section"'
    },
    {
      detailsId: 'recentHistoryDisclosure',
      summaryLabel: 'Histórico recente',
      innerMarker: 'id="recentHistorySection"'
    },
    {
      detailsId: 'deviceLookupDisclosure',
      summaryLabel: 'Consulte seu dispositivo',
      innerMarker: 'class="device-card"'
    }
  ];

  for (const spec of specs) {
    const startTagMatch = html.match(new RegExp(`<details[^>]*id="${spec.detailsId}"[^>]*>`));
    assert.ok(startTagMatch, `Deve existir <details id="${spec.detailsId}">`);
    assert.equal(
      /\bopen\b/i.test(startTagMatch[0]),
      false,
      `<details id="${spec.detailsId}"> deve iniciar fechado (sem atributo open)`
    );

    const openIdx = html.indexOf(startTagMatch[0]);
    const closeIdx = html.indexOf('</details>', openIdx);
    assert.ok(closeIdx > openIdx, `<details id="${spec.detailsId}"> deve fechar corretamente`);

    const block = html.slice(openIdx, closeIdx);
    const summaryMatch = block.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/);
    assert.ok(summaryMatch, `<details id="${spec.detailsId}"> deve conter <summary>`);
    assert.ok(
      summaryMatch[1].includes(spec.summaryLabel),
      `<summary> de ${spec.detailsId} deve conter "${spec.summaryLabel}"`
    );
    assert.ok(
      block.includes(spec.innerMarker),
      `<details id="${spec.detailsId}"> deve encapsular ${spec.innerMarker}`
    );
  }
});

test('todos os IDs críticos de capacidades, histórico/exportação e dispositivo são preservados em index.html', () => {
  const html = readUtf8('index.html');

  const requiredIds = [
    'capabilitiesSubtitle',
    'capabilitiesGrid',
    'recentHistoryCountBadge',
    'recentHistorySection',
    'recentHistoryEmpty',
    'recentHistoryList',
    'recentExportCsvBtn',
    'recentExportJsonBtn',
    'recentClearHistoryBtn',
    'deviceBrandStep',
    'deviceBrandGrid',
    'deviceModelStep',
    'deviceSearchForm',
    'deviceQueryInput',
    'deviceSearchBtn',
    'deviceResultPanel',
    'deviceGoogleLink',
    'deviceLiveSuggestions'
  ];

  for (const id of requiredIds) {
    assert.ok(html.includes(`id="${id}"`), `ID crítico #${id} deve existir em index.html`);
  }
});

test('simple-mode.css estiliza 3 níveis, acessibilidade de <summary> e oculta disclosures em body.is-embed', () => {
  const css = readUtf8('src', 'styles', 'simple-mode.css');

  assert.match(css, /\.surface-level-2\s*\{[^}]*background:\s*var\(--surface-1\)/s);
  assert.match(css, /\.disclosure-panel\s*\{[^}]*background:\s*var\(--bg-1\)/s);
  assert.match(css, /\.disclosure-summary\s*\{[^}]*cursor:\s*pointer/s);
  assert.match(css, /\.disclosure-summary:focus-visible\s*\{[^}]*outline:/s);
  assert.ok(css.includes('body.is-embed .disclosure-panel'));
  assert.ok(css.includes('body.is-embed #moreUsesDisclosure'));
  assert.ok(css.includes('body.is-embed #recentHistoryDisclosure'));
  assert.ok(css.includes('body.is-embed #deviceLookupDisclosure'));
});

test('renderRecentHistoryPanel atualiza #recentHistoryCountBadge com contagem dinâmica e segura', () => {
  const prevDocument = globalThis.document;

  const listEl = createDomNode('ul', 'recentHistoryList');
  const emptyEl = createDomNode('p', 'recentHistoryEmpty');
  const countBadgeEl = createDomNode('span', 'recentHistoryCountBadge');
  const csvBtn = createDomNode('button', 'recentExportCsvBtn');
  const jsonBtn = createDomNode('button', 'recentExportJsonBtn');
  const clearBtn = createDomNode('button', 'recentClearHistoryBtn');

  const byId = new Map([
    ['recentHistoryList', listEl],
    ['recentHistoryEmpty', emptyEl],
    ['recentHistoryCountBadge', countBadgeEl],
    ['recentExportCsvBtn', csvBtn],
    ['recentExportJsonBtn', jsonBtn],
    ['recentClearHistoryBtn', clearBtn]
  ]);

  try {
    globalThis.document = {
      getElementById: (id) => byId.get(id) || null,
      createElement: (tag) => createDomNode(tag)
    };

    renderRecentHistoryPanel([]);
    assert.equal(countBadgeEl.textContent, '0 testes');
    assert.equal(csvBtn.disabled, true);
    assert.equal(emptyEl.classList.contains('hidden'), false);

    renderRecentHistoryPanel([
      {
        timestamp: '2026-11-23T19:00:00Z',
        ispName: 'Fibra',
        serverLabel: 'SP',
        downloadMbps: 500,
        uploadMbps: 250,
        pingMs: 10,
        loadedDeltaMs: 4,
        stabilityLabel: 'Estável'
      }
    ]);
    assert.equal(countBadgeEl.textContent, '1 teste');
    assert.equal(csvBtn.disabled, false);
    assert.equal(emptyEl.classList.contains('hidden'), true);
    assert.equal(listEl.children.length, 1);

    renderRecentHistoryPanel([
      { timestamp: '2026-11-23T19:00:00Z', downloadMbps: 500, uploadMbps: 250, pingMs: 10 },
      { timestamp: '2026-11-23T18:00:00Z', downloadMbps: 480, uploadMbps: 240, pingMs: 12 }
    ]);
    assert.equal(countBadgeEl.textContent, '2 testes');
    assert.equal(listEl.children.length, 2);
  } finally {
    globalThis.document = prevDocument;
  }
});
