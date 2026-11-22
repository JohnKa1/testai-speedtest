import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildGoogleSearchUrl } from '../src/utils/google-search.js';

describe('TestAi — buildGoogleSearchUrl (Etapa 1 - Função Pura de Busca Externa)', () => {
  it('retorna null quando o modelo é vazio, nulo, indefinido ou contém apenas espaços', () => {
    assert.equal(buildGoogleSearchUrl('Samsung', ''), null);
    assert.equal(buildGoogleSearchUrl('Samsung', '    \t\n  '), null);
    assert.equal(buildGoogleSearchUrl('Apple', null), null);
    assert.equal(buildGoogleSearchUrl('Motorola', undefined), null);
  });

  it('normaliza espaços extras no modelo e no rótulo da marca', () => {
    const rawUrl = buildGoogleSearchUrl('  Samsung  ', '  Galaxy    A54   5G  ');
    assert.ok(rawUrl);
    const parsed = new URL(rawUrl);
    assert.equal(parsed.origin, 'https://www.google.com');
    assert.equal(parsed.pathname, '/search');
    assert.equal(parsed.searchParams.get('q'), 'Samsung Galaxy A54 5G especificações Wi-Fi');
  });

  it('codifica corretamente acentos e caracteres especiais (&, #, +, emoji)', () => {
    const rawUrl = buildGoogleSearchUrl('Motorola', 'Moto G84+ & Edição #1 📱');
    assert.ok(rawUrl);
    assert.ok(rawUrl.includes('%26'), 'Deve codificar &');
    assert.ok(rawUrl.includes('%23'), 'Deve codificar #');
    assert.ok(rawUrl.includes('%2B'), 'Deve codificar +');
    const parsed = new URL(rawUrl);
    assert.equal(
      parsed.searchParams.get('q'),
      'Motorola Moto G84+ & Edição #1 📱 especificações Wi-Fi'
    );
  });

  it('não duplica a marca quando o texto do modelo já começa por ela (case-insensitive)', () => {
    const urlLower = buildGoogleSearchUrl('Samsung', 'samsung galaxy s24 ultra');
    assert.ok(urlLower);
    assert.equal(
      new URL(urlLower).searchParams.get('q'),
      'samsung galaxy s24 ultra especificações Wi-Fi'
    );

    const urlExact = buildGoogleSearchUrl('Apple', 'Apple iPhone 15 Pro');
    assert.ok(urlExact);
    assert.equal(
      new URL(urlExact).searchParams.get('q'),
      'Apple iPhone 15 Pro especificações Wi-Fi'
    );
  });

  it('ignora rótulo de marca vazio passado pelo chamador (E1: caso brand.id === "outras")', () => {
    const urlEmptyBrand = buildGoogleSearchUrl('', 'Zenfone 10');
    assert.ok(urlEmptyBrand);
    assert.equal(
      new URL(urlEmptyBrand).searchParams.get('q'),
      'Zenfone 10 especificações Wi-Fi'
    );

    const urlWhitespaceBrand = buildGoogleSearchUrl('   ', 'Pixel 9 Pro');
    assert.ok(urlWhitespaceBrand);
    assert.equal(
      new URL(urlWhitespaceBrand).searchParams.get('q'),
      'Pixel 9 Pro especificações Wi-Fi'
    );
  });

  it('trunca texto de modelo muito longo em 100 caracteres antes de montar a consulta', () => {
    const longModel = `Galaxy ${'X'.repeat(130)}`;
    const rawUrl = buildGoogleSearchUrl('Samsung', longModel);
    assert.ok(rawUrl);
    const expectedTruncatedModel = longModel.slice(0, 100);
    assert.equal(expectedTruncatedModel.length, 100);
    const parsed = new URL(rawUrl);
    assert.equal(
      parsed.searchParams.get('q'),
      `Samsung ${expectedTruncatedModel} especificações Wi-Fi`
    );
  });
});
