/**
 * Utilitário puro para construção segura de URL de pesquisa externa no Google.
 * Não acessa o DOM nem realiza chamadas de rede.
 */

/**
 * Monta a URL de busca no Google para especificações Wi-Fi do dispositivo.
 * Conforme E1, não compara rótulos específicos: o chamador passa '' quando brand.id === 'outras'
 * e a função ignora rótulo vazio.
 *
 * @param {string | null | undefined} brandLabel
 * @param {string | null | undefined} model
 * @returns {string | null}
 */
export function buildGoogleSearchUrl(brandLabel, model) {
  const cleanModel = String(model ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!cleanModel) return null;
  const brand = String(brandLabel ?? '').replace(/\s+/g, ' ').trim();
  const alreadyHasBrand =
    Boolean(brand) && cleanModel.toLowerCase().startsWith(brand.toLowerCase());
  const query = [alreadyHasBrand ? '' : brand, cleanModel, 'especificações Wi-Fi']
    .filter(Boolean)
    .join(' ');
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  return url.toString();
}
