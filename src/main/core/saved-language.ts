import { normalizeLanguagePreference, type LanguagePreference } from '@shared/i18n/languages'
import { FORMAT_VERSIONS, parseStoreJson } from '@main/io/format-version'

/**
 * The saved language choice, read from the settings file's text before the app
 * is ready and without touching the file, so Chromium's own strings can take it
 * from a switch that only applies before ready. Anything unreadable follows the
 * computer, which is also what the settings store does with it, and so does a
 * file in a newer format, which this build cannot read.
 */
export function readSavedLanguagePreference(configText: string | null): LanguagePreference {
  if (configText === null) return 'system'
  const found = parseStoreJson(configText, FORMAT_VERSIONS.config, true)
  return found.status === 'read' ? normalizeLanguagePreference(found.value['language']) : 'system'
}
