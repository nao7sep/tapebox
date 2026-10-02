import en from './locales/en.json'
import type { Language } from './languages'

// English defines the key set; every other catalogue carries every key, with
// plural entries keyed by the language's own CLDR categories. The catalogue
// gate (tests/i18n/catalogues.test.ts) checks keys, placeholders, plural forms,
// and untranslated English.
export type MessageKey = keyof typeof en

export type CatalogueEntry = string | Readonly<Record<string, string>>

export type Catalogue = Readonly<Record<MessageKey, CatalogueEntry>>

// One dynamic import per catalogue, so each process loads only the interface
// language and English (localization-stack-conventions, Electron with React).
const LOADERS: Readonly<Record<Language, () => Promise<Catalogue>>> = {
  en: () => Promise.resolve(en),
  de: () => import('./locales/de.json').then((module) => module.default),
  es: () => import('./locales/es.json').then((module) => module.default),
  fr: () => import('./locales/fr.json').then((module) => module.default),
  it: () => import('./locales/it.json').then((module) => module.default),
  'pt-BR': () => import('./locales/pt-BR.json').then((module) => module.default),
  ru: () => import('./locales/ru.json').then((module) => module.default),
  ja: () => import('./locales/ja.json').then((module) => module.default),
  ko: () => import('./locales/ko.json').then((module) => module.default),
  'zh-Hans': () => import('./locales/zh-Hans.json').then((module) => module.default),
}

const loaded = new Map<Language, Catalogue>([['en', en]])

export async function loadCatalogue(language: Language): Promise<Catalogue> {
  const cached = loaded.get(language)
  if (cached) return cached
  const catalogue = await LOADERS[language]()
  loaded.set(language, catalogue)
  return catalogue
}

export function isCatalogueLoaded(language: Language): boolean {
  return loaded.has(language)
}

// A catalogue already loaded; a translator is only ever built for one.
export function loadedCatalogue(language: Language): Catalogue {
  const catalogue = loaded.get(language)
  if (!catalogue) throw new Error(`The ${language} catalogue is not loaded`)
  return catalogue
}
