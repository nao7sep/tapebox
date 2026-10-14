import { BrowserWindow, nativeTheme } from 'electron'
import type { ThemePreference } from '@shared/settings'

// Electron's nativeTheme.themeSource is TapeBox's one theme authority (app-chrome
// conventions, Theme): it paints the native title bar, menus, and dialogs, and it
// decides `prefers-color-scheme` in every renderer, which is what globals.css's
// dark block and the plain message dialog follow. No renderer resolves System
// itself.

// globals.css's --color-canvas in each theme, so the frames before a page paints
// and the backing exposed while resizing already match it.
const LIGHT_BACKGROUND = '#ffffff'
const DARK_BACKGROUND = '#09090b'

export function windowBackground(dark: boolean = nativeTheme.shouldUseDarkColors): string {
  return dark ? DARK_BACKGROUND : LIGHT_BACKGROUND
}

function syncWindowBackgrounds(): void {
  const color = windowBackground()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setBackgroundColor(color)
  }
}

// The OS appearance last seen while themeSource was System. Electron reports only
// the resolved theme, so while Light or Dark is forced this is the appearance from
// launch or from the last time System was in force.
let systemDark: boolean | null = null

function noteSystemAppearance(): void {
  if (nativeTheme.themeSource === 'system') systemDark = nativeTheme.shouldUseDarkColors
}

/** What the System choice resolves to now, for its label in Settings. */
export function systemAppearance(): 'light' | 'dark' {
  noteSystemAppearance()
  return (systemDark ?? nativeTheme.shouldUseDarkColors) ? 'dark' : 'light'
}

/** Applies a saved choice to the whole app; System follows the OS. */
export function applyThemePreference(preference: ThemePreference): void {
  noteSystemAppearance()
  nativeTheme.themeSource = preference
  noteSystemAppearance()
  syncWindowBackgrounds()
}

/** Keeps window backgrounds in step when the OS appearance changes under System. */
export function followOsThemeChanges(): void {
  nativeTheme.on('updated', () => {
    noteSystemAppearance()
    syncWindowBackgrounds()
  })
}
