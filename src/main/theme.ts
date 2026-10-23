import { app, BrowserWindow, nativeTheme, systemPreferences } from 'electron'
import { execCapture } from '@main/io/spawn'
import { emit } from '@main/ipc/events'
import type { ThemePreference } from '@shared/settings'
import { themeTokens } from '@shared/theme-tokens'
import globalsCss from '../renderer/styles/globals.css?raw'

// Electron's nativeTheme.themeSource is TapeBox's one theme authority (app-chrome
// conventions, Theme): it paints the native title bar, menus, and dialogs, and it
// decides `prefers-color-scheme` in every renderer, which is what globals.css's
// dark block and the plain message dialog follow. No renderer resolves System
// itself.

/** The renderer's colour tokens, for surfaces drawn outside its stylesheet. */
export const THEME_TOKENS = themeTokens(globalsCss)

// The canvas token in each theme, so the frames before a page paints and the
// backing exposed while resizing already match it.
export function windowBackground(dark: boolean = nativeTheme.shouldUseDarkColors): string {
  return THEME_TOKENS[dark ? 'dark' : 'light']['--color-canvas']!
}

function syncWindowBackgrounds(): void {
  const color = windowBackground()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setBackgroundColor(color)
  }
}

/** Read the OS preference without changing the application's theme authority. */
export async function systemAppearance(): Promise<'light' | 'dark'> {
  if (nativeTheme.themeSource === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  if (process.platform === 'darwin') {
    return systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark' ? 'dark' : 'light'
  }
  if (process.platform === 'win32') {
    // The Windows system-chrome theme can differ from its application theme.
    // Read AppsUseLightTheme, whose absent-value default is light. PowerShell's
    // registry API distinguishes absence from a failed read without localized prose.
    const { stdout } = await execCapture('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; $value = [Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', 'AppsUseLightTheme', 1); if ($null -eq $value) { 1 } else { $value }",
    ], { signal: AbortSignal.timeout(5000), windowsHide: true })
    const value = stdout.trim()
    if (value === '0') return 'dark'
    if (value === '1') return 'light'
    throw new Error('Invalid Windows application appearance preference')
  }
  throw new Error('Independent system appearance is unavailable on this platform')
}

/** Applies a saved choice to the whole app; System follows the OS. */
export function applyThemePreference(preference: ThemePreference): void {
  nativeTheme.themeSource = preference
  syncWindowBackgrounds()
}

/** Follow OS notifications even when the application theme masks their appearance. */
export function followOsThemeChanges(): void {
  const changed = () => emit('settings:systemAppearanceChanged', null)
  nativeTheme.on('updated', () => {
    syncWindowBackgrounds()
    changed()
  })
  if (process.platform === 'darwin') {
    const subscription = systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', changed)
    app.once('will-quit', () => systemPreferences.unsubscribeNotification(subscription))
  } else if (process.platform === 'win32') {
    // WM_SETTINGCHANGE reaches each top-level window when Windows preferences change.
    const watch = (window: BrowserWindow) => window.hookWindowMessage(0x001a, changed)
    for (const window of BrowserWindow.getAllWindows()) watch(window)
    app.on('browser-window-created', (_event, window) => watch(window))
  }
}
