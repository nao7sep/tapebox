import { useEffect } from 'react'
import { useSettingsStore } from '@renderer/store/settings'

/**
 * Apply the user's configured UI font family to the document.
 *
 * The default family stack lives in globals.css (@theme --font-sans); this only
 * *overrides* it when uiFontFamily is non-empty, mirroring how a blank
 * libraryDir/externalPlayer means "use the default". The string is handed to CSS
 * verbatim — the browser resolves the comma-separated stack and falls back on its
 * own, so a misspelled or absent font never breaks text (app-chrome-conventions:
 * web fonts are engine-resolved, not parsed). Clearing the field reverts to the
 * default by removing the inline override.
 */
export function useUiFont(): void {
  const family = useSettingsStore((s) => s.settings?.uiFontFamily ?? '')
  useEffect(() => {
    const root = document.documentElement
    const value = family.trim()
    if (value) root.style.setProperty('--font-sans', value)
    else root.style.removeProperty('--font-sans')
  }, [family])
}
