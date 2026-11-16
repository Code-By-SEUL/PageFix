// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Marius SEUL – https://code-by-seul.ro/
// =====================================================================
//  PageFix – traduceri
//
//  Textele vin din lang/<cod>.json, prin index.php, în variabila globală
//  window.I18N = { lang, locale, languages, dict }.
// =====================================================================

// Valori de rezervă, folosite doar dacă pagina nu a primit window.I18N.
const FALLBACK_I18N = { lang: 'en', locale: 'en-GB', languages: [], dict: {} };

let i18nData = window.I18N;
if (!i18nData) {
  i18nData = FALLBACK_I18N;
}

// Regulile de plural ale limbii (ex. în română: „1 pagină”, „3 pagini”, „20 de pagini”).
const pluralRules = new Intl.PluralRules(i18nData.lang);

// Marcaj de forma {nume} într-un text tradus.
const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

export const LANG = i18nData.lang;
export const LOCALE = i18nData.locale;
export const LANGUAGES = i18nData.languages;

/**
 * Traduce o cheie în limba curentă.
 *
 * Exemplu: t('msg.added', { n: 3 }) -> "Adăugate 3 pagini."
 *
 * - Marcajele {nume} se înlocuiesc cu vars.nume. Marcajele fără valoare în vars rămân
 *   neschimbate (ex. {n} din șabloanele de numerotare a paginilor).
 * - Un text poate avea mai multe forme de plural: { one, few, other }; forma se alege
 *   după vars.n.
 * - Dacă cheia nu există, se întoarce chiar cheia (și se scrie un avertisment în consolă).
 *
 * Rezultatul este text simplu (NU HTML).
 */
export function t(key, vars = {}) {
  let value = i18nData.dict[key];

  if (value === null || value === undefined) {
    console.warn('i18n: missing key', key);
    return key;
  }

  // Text cu forme de plural: se alege forma potrivită pentru numărul vars.n.
  if (typeof value === 'object') {
    let count = 0;
    if (vars.n !== null && vars.n !== undefined) {
      count = vars.n;
    }
    const pluralCategory = pluralRules.select(Number(count));

    let selectedForm = value[pluralCategory];
    if (selectedForm === null || selectedForm === undefined) {
      selectedForm = value.other;
    }
    value = selectedForm;
  }

  const text = String(value);

  function replacePlaceholder(fullMatch, variableName) {
    if (variableName in vars) {
      return String(vars[variableName]);
    }
    return fullMatch;
  }

  return text.replace(PLACEHOLDER_PATTERN, replacePlaceholder);
}
