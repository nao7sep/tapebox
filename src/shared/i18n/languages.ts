// The interface languages TapeBox ships, in the order the Settings picker lists
// them after System: Latin-script languages alphabetically by their own names,
// then Cyrillic, then CJK. Each tag names a catalogue in ./locales, which both
// the main process (native menu, recovery dialogs, error text sent to the
// window) and the renderer read.
//
// A tag says exactly which variety a catalogue is written in, while the picker
// shows each language by its plain name: zh-Hans is Simplified Chinese, shown
// as 中文, and pt-BR is Brazilian Portuguese, shown as Português. Each is the
// app's only variety of its language, so every Chinese or Portuguese computer
// resolves to it.
export const LANGUAGES = ['en', 'de', 'es', 'fr', 'it', 'pt-BR', 'ru', 'ja', 'ko', 'zh-Hans'] as const

export type Language = (typeof LANGUAGES)[number]

// The saved choice. System follows the computer's language on every launch.
export const LANGUAGE_PREFERENCES = ['system', ...LANGUAGES] as const
export type LanguagePreference = (typeof LANGUAGE_PREFERENCES)[number]

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}

// A missing, retired, or hand-edited value follows the computer, in the settings
// schema and in main's pre-launch read alike, so both agree on the language.
export function normalizeLanguagePreference(value: unknown): LanguagePreference {
  return isLanguage(value) ? value : 'system'
}

export function effectiveLanguage(preference: LanguagePreference, systemLanguage: Language): Language {
  return preference === 'system' ? systemLanguage : preference
}

/**
 * System: walk the computer's preferred languages in order and take the first one
 * in the set. Every Chinese locale (Taiwan and Hong Kong included) resolves to
 * zh-Hans, every Portuguese one to pt-BR, and every Spanish one to es; a language
 * outside the set is skipped, and English is the fallback.
 */
export function resolveComputerLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    let language: string
    try {
      language = new Intl.Locale(tag.replace(/_/g, '-')).language
    } catch {
      continue
    }
    if (language === 'zh') return 'zh-Hans'
    if (language === 'pt') return 'pt-BR'
    if (isLanguage(language)) return language
  }
  return 'en'
}

// Dates and numbers follow the computer's regional format when it is in the
// interface language (British English dates for an en-GB computer), and the
// interface language's own format otherwise.
export function formattingLocale(language: Language, systemLocale: string | null): string {
  if (systemLocale === null) {
    return language
  }
  try {
    const system = new Intl.Locale(systemLocale).maximize()
    const target = new Intl.Locale(language).maximize()
    const sameLanguage = system.language === target.language && system.script === target.script
    return sameLanguage && Intl.DateTimeFormat.supportedLocalesOf([systemLocale]).length > 0
      ? systemLocale
      : language
  } catch {
    return language
  }
}

/**
 * Chromium's name for the interface language, handed to its `--lang` switch so
 * the strings the engine draws itself (the video player's controls, form
 * validation) speak the same language as the page.
 */
export function chromiumLocale(language: Language): string {
  return language === 'zh-Hans' ? 'zh-CN' : language
}

/**
 * What main tells a window about language before it draws anything: the saved
 * choice as of the window's creation, and the computer's language and regional
 * format, read once at launch. The renderer resolves the interface language from
 * these and the settings it later hydrates, so both processes agree.
 */
export type LanguageEnvironment = {
  preference: LanguagePreference
  systemLanguage: Language
  systemLocale: string | null
}
