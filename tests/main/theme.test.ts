import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const windows: Array<{ setBackgroundColor: ReturnType<typeof vi.fn>; isDestroyed: () => boolean }> = []
  const listeners: Record<string, () => void> = {}
  const nativeTheme = {
    themeSource: 'system' as string,
    shouldUseDarkColors: false,
    on: vi.fn((event: string, listener: () => void) => {
      listeners[event] = listener
    }),
  }
  return { windows, listeners, nativeTheme }
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => electron.windows },
  nativeTheme: electron.nativeTheme,
}))

import { applyThemePreference, followOsThemeChanges, systemAppearance, windowBackground } from '@main/theme'

beforeEach(() => {
  electron.windows.splice(0)
  electron.nativeTheme.themeSource = 'system'
  electron.nativeTheme.shouldUseDarkColors = false
})

describe('theme', () => {
  // Electron resolves a forced theme, so the System label reads the OS appearance
  // last seen while System was in force (app-chrome-conventions, Theme).
  it('reports the OS appearance for the System label, even while a theme is forced', () => {
    electron.nativeTheme.shouldUseDarkColors = true
    expect(systemAppearance()).toBe('dark')
    applyThemePreference('light')
    electron.nativeTheme.shouldUseDarkColors = false
    expect(systemAppearance()).toBe('dark')
    applyThemePreference('system')
    electron.nativeTheme.shouldUseDarkColors = false
    expect(systemAppearance()).toBe('light')
  })

  it('hands the saved choice to Electron as the one theme authority', () => {
    applyThemePreference('light')
    expect(electron.nativeTheme.themeSource).toBe('light')
    applyThemePreference('system')
    expect(electron.nativeTheme.themeSource).toBe('system')
  })

  it('repaints window backgrounds in the resolved theme, on Save and on an OS change', () => {
    const window = { setBackgroundColor: vi.fn(), isDestroyed: () => false }
    electron.windows.push(window)
    electron.nativeTheme.shouldUseDarkColors = true
    applyThemePreference('dark')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(windowBackground(true))

    followOsThemeChanges()
    electron.nativeTheme.shouldUseDarkColors = false
    electron.listeners.updated?.()
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(windowBackground(false))
  })

})
