import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  return { windows, listeners, nativeTheme,
    execCapture: vi.fn(), emit: vi.fn(),
    app: { on: vi.fn(), once: vi.fn() },
    systemPreferences: { getUserDefault: vi.fn(), subscribeNotification: vi.fn((_name: string, _listener: () => void) => 7), unsubscribeNotification: vi.fn() },
  }
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => electron.windows },
  nativeTheme: electron.nativeTheme,
  app: electron.app,
  systemPreferences: electron.systemPreferences,
}))

vi.mock('@main/io/spawn', () => ({ execCapture: electron.execCapture }))
vi.mock('@main/ipc/events', () => ({ emit: electron.emit }))

import { applyThemePreference, followOsThemeChanges, systemAppearance, windowBackground } from '@main/theme'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  electron.windows.splice(0)
  electron.nativeTheme.themeSource = 'system'
  electron.nativeTheme.shouldUseDarkColors = false
})

describe('theme', () => {
  it.each(['light', 'dark'] as const)('reads changing macOS preferences while %s is forced', async (preference) => {
    applyThemePreference(preference)
    electron.systemPreferences.getUserDefault.mockReturnValue('Dark')
    await expect(systemAppearance()).resolves.toBe('dark')
    electron.systemPreferences.getUserDefault.mockReturnValue('')
    await expect(systemAppearance()).resolves.toBe('light')
    expect(electron.nativeTheme.themeSource).toBe(preference)
  })

  it('reads Windows application preference separately from the forced theme', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    applyThemePreference('dark')
    electron.execCapture.mockResolvedValueOnce({ stdout: '1\r\n' }).mockResolvedValueOnce({ stdout: '0\r\n' })
    await expect(systemAppearance()).resolves.toBe('light')
    await expect(systemAppearance()).resolves.toBe('dark')
    expect(electron.execCapture).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining([
      expect.stringContaining("'AppsUseLightTheme', 1"),
    ]), { signal: expect.any(AbortSignal), windowsHide: true })
    expect(electron.nativeTheme.themeSource).toBe('dark')
    electron.execCapture.mockRejectedValueOnce(new Error('registry read failed'))
    await expect(systemAppearance()).rejects.toThrow('registry read failed')
    electron.execCapture.mockResolvedValueOnce({ stdout: 'invalid' })
    await expect(systemAppearance()).rejects.toThrow('Invalid Windows')
  })

  it('uses Electron directly when it already follows System', async () => {
    electron.nativeTheme.shouldUseDarkColors = true
    await expect(systemAppearance()).resolves.toBe('dark')
    expect(electron.execCapture).not.toHaveBeenCalled()
    expect(electron.systemPreferences.getUserDefault).not.toHaveBeenCalled()
  })

  it('invalidates the label on a macOS preference notification and releases the subscription', () => {
    followOsThemeChanges()
    const changed = electron.systemPreferences.subscribeNotification.mock.calls[0]![1] as () => void
    changed()
    expect(electron.emit).toHaveBeenCalledWith('settings:systemAppearanceChanged', null)
    const quit = electron.app.once.mock.calls[0]![1] as () => void
    quit()
    expect(electron.systemPreferences.unsubscribeNotification).toHaveBeenCalledWith(7)
  })

  it('watches Windows preference messages on each new window', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    followOsThemeChanges()
    const created = electron.app.on.mock.calls[0]![1] as (event: unknown, window: unknown) => void
    const hookWindowMessage = vi.fn()
    created({}, { hookWindowMessage })
    expect(hookWindowMessage).toHaveBeenCalledWith(0x001a, expect.any(Function))
    hookWindowMessage.mock.calls[0]![1]()
    expect(electron.emit).toHaveBeenCalledWith('settings:systemAppearanceChanged', null)
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

afterEach(() => vi.restoreAllMocks())
