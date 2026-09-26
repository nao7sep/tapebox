import type { TapeBoxApi } from '@shared/bridge'
import { effectiveLanguage, formattingLocale, type Language } from '@shared/i18n/languages'
import { useSettingsStore } from '@renderer/store/settings'

const environment = (window as unknown as { tapebox: TapeBoxApi }).tapebox.languageEnvironment

/**
 * The interface language: the saved choice (main's copy until settings hydrate),
 * with System resolved to the computer's language, and the locale dates and
 * numbers are formatted in. A change saved in Settings applies at once.
 */
export function useInterfaceLanguage(): { language: Language; locale: string } {
  const saved = useSettingsStore((s) => s.settings?.language)
  const language = effectiveLanguage(saved ?? environment.preference, environment.systemLanguage)
  return { language, locale: formattingLocale(language, environment.systemLocale) }
}
