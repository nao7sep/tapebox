import { normalizeLanguagePreference, type LanguagePreference } from '@shared/i18n/languages'

/**
 * The saved language choice, read from the settings file's text before the app
 * is ready and without touching the file, so Chromium's own strings can take it
 * from a switch that only applies before ready. Anything unreadable follows the
 * computer, which is also what the settings store does with it.
 */
export function readSavedLanguagePreference(configText: string | null): LanguagePreference {
  if (configText === null) return 'system'
  try {
    const parsed: unknown = JSON.parse(configText)
    return normalizeLanguagePreference((parsed as { language?: unknown } | null)?.language)
  } catch {
    return 'system'
  }
}
