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

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyThemePreference, followOsThemeChanges, windowBackground } from '@main/theme'

beforeEach(() => {
  electron.windows.splice(0)
  electron.nativeTheme.themeSource = 'system'
  electron.nativeTheme.shouldUseDarkColors = false
})

describe('theme', () => {
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

  it("uses globals.css's --color-canvas in each theme so the frame behind the page never flashes", () => {
    const css = readFileSync(resolve('src/renderer/styles/globals.css'), 'utf8')
    const light = css.slice(css.indexOf('@theme {\n  /* The window'))
    const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark) {'))
    const canvas = (block: string) => block.match(/--color-canvas:\s*(#[0-9a-f]{6});/i)?.[1]?.toLowerCase()
    expect(windowBackground(false)).toBe(canvas(light))
    expect(windowBackground(true)).toBe(canvas(dark))
  })
})
