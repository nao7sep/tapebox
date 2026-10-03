import { useEffect, useState } from 'react'
import type { TapeBoxApi } from '@shared/bridge'
import { isCatalogueLoaded, loadCatalogue } from '@shared/i18n/catalogues'
import { effectiveLanguage, formattingLocale, type Language, type LanguagePreference } from '@shared/i18n/languages'
import { describeError } from '@shared/error'
import { log } from '@renderer/ipc/log'
import { useSettingsStore } from '@renderer/store/settings'

const environment = (window as unknown as { tapebox: TapeBoxApi }).tapebox.languageEnvironment

/**
 * The interface language: the saved choice (main's copy until settings hydrate),
 * with System resolved to the computer's language, and the locale dates and
 * numbers are formatted in. A change saved in Settings applies as soon as its
 * catalogue has loaded. Null until the first one has, so the first words on
 * screen are already in it; a catalogue that cannot load leaves the language
 * already shown, or English.
 */
export function useInterfaceLanguage(): { language: Language; locale: string } | null {
  const saved = useSettingsStore((s) => s.settings?.language)
  return useLanguage(saved ?? environment.preference)
}

/** The window's saved choice as of its creation, before anything else says otherwise. */
export function initialLanguagePreference(): LanguagePreference {
  return environment.preference
}

/**
 * The interface language for a saved choice: System resolved to the computer's
 * language, shown once its catalogue has loaded (see useInterfaceLanguage).
 */
export function useLanguage(preference: LanguagePreference): { language: Language; locale: string } | null {
  const wanted = effectiveLanguage(preference, environment.systemLanguage)
  const [shown, setShown] = useState<Language | null>(() => (isCatalogueLoaded(wanted) ? wanted : null))

  useEffect(() => {
    if (wanted === shown) return
    let current = true
    loadCatalogue(wanted).then(
      () => {
        if (current) setShown(wanted)
      },
      (error: unknown) => {
        log.warn('language catalogue could not be loaded', { language: wanted, error: describeError(error) })
        if (current) setShown((previous) => previous ?? 'en')
      },
    )
    return () => {
      current = false
    }
  }, [wanted, shown])

  return shown === null ? null : { language: shown, locale: formattingLocale(shown, environment.systemLocale) }
}
