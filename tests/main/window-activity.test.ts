import { describe, expect, it, vi } from 'vitest'
import { configureWindowActivity } from '../../src/main/window-activity'
import { WINDOW_ACTIVITY_CHANNEL } from '../../src/shared/window-activity'

describe('native window activity transport', () => {
  it('uses window focus when the platform has no application activity API', () => {
    const contentListeners = new Map<string, () => void>()
    const send = vi.fn()
    const application = {
      on: vi.fn(),
      removeListener: vi.fn(),
    }
    const window = {
      on: vi.fn(() => window),
      once: vi.fn(() => window),
      isFocused: () => true,
      webContents: {
        on: vi.fn((event: string, listener: () => void) => contentListeners.set(event, listener)),
        isDestroyed: () => false,
        send,
      },
    }

    expect(() =>
      configureWindowActivity(
        application as unknown as Electron.App,
        window as unknown as Electron.BrowserWindow,
      ),
    ).not.toThrow()
    contentListeners.get('did-finish-load')?.()
    expect(send).toHaveBeenLastCalledWith(WINDOW_ACTIVITY_CHANNEL, true)
  })

  it('requires both application activation and owner-window focus', () => {
    const applicationListeners = new Map<string, () => void>()
    const windowListeners = new Map<string, () => void>()
    const contentListeners = new Map<string, () => void>()
    const send = vi.fn()
    let focused = false
    let destroyed = false
    const application = {
      isActive: () => true,
      on: vi.fn((event: string, listener: () => void) => applicationListeners.set(event, listener)),
      removeListener: vi.fn(),
    }
    const window = {
      on: vi.fn((event: string, listener: () => void) => {
        windowListeners.set(event, listener)
        return window
      }),
      once: vi.fn((event: string, listener: () => void) => {
        windowListeners.set(event, listener)
        return window
      }),
      isFocused: () => focused,
      webContents: {
        on: vi.fn((event: string, listener: () => void) => contentListeners.set(event, listener)),
        isDestroyed: () => destroyed,
        send,
      },
    }

    configureWindowActivity(
      application as unknown as Electron.App,
      window as unknown as Electron.BrowserWindow,
    )
    contentListeners.get('did-finish-load')?.()
    expect(send).toHaveBeenLastCalledWith(WINDOW_ACTIVITY_CHANNEL, false)

    focused = true
    windowListeners.get('focus')?.()
    expect(send).toHaveBeenLastCalledWith(WINDOW_ACTIVITY_CHANNEL, true)

    // This is the macOS defect: BrowserWindow and DOM focus remain true while
    // NSApplication has resigned active status.
    applicationListeners.get('did-resign-active')?.()
    expect(send).toHaveBeenLastCalledWith(WINDOW_ACTIVITY_CHANNEL, false)
    expect(focused).toBe(true)
    applicationListeners.get('did-become-active')?.()
    expect(send).toHaveBeenLastCalledWith(WINDOW_ACTIVITY_CHANNEL, true)

    windowListeners.get('blur')?.()
    expect(send).toHaveBeenLastCalledWith(WINDOW_ACTIVITY_CHANNEL, false)
    destroyed = true
    windowListeners.get('focus')?.()
    expect(send).toHaveBeenCalledTimes(5)

    windowListeners.get('closed')?.()
    expect(application.removeListener).toHaveBeenCalledWith(
      'did-become-active',
      applicationListeners.get('did-become-active'),
    )
    expect(application.removeListener).toHaveBeenCalledWith(
      'did-resign-active',
      applicationListeners.get('did-resign-active'),
    )
  })
})
