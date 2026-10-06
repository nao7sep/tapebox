import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => {
  let loadError: Error | null = null
  let measurementError: Error | null = null
  let lastWindow: MockBrowserWindow | null = null
  let windowCount = 0
  class MockBrowserWindow {
    static getFocusedWindow = () => null
    private closedHandler: (() => void) | null = null
    private domReadyHandler: (() => void) | null = null
    private destroyed = false
    navigateHandler: ((event: { preventDefault: () => void }, url: string) => void) | null = null
    webContents = {
      on: vi.fn((event: string, handler: (event: { preventDefault: () => void }, url: string) => void) => {
        if (event === 'will-navigate') this.navigateHandler = handler
      }),
      once: vi.fn((event: string, handler: () => void) => { if (event === 'dom-ready') this.domReadyHandler = handler }),
      executeJavaScript: vi.fn(() => measurementError ? Promise.reject(measurementError) : Promise.resolve(240)),
    }
    constructor(_options: unknown) { lastWindow = this; windowCount += 1 }
    on(event: string, handler: () => void): void { if (event === 'closed') this.closedHandler = handler }
    loadURL(): Promise<void> { return loadError ? Promise.reject(loadError) : Promise.resolve() }
    isDestroyed(): boolean { return this.destroyed }
    close(): void { this.destroyed = true; this.closedHandler?.() }
    setContentSize(): void {}
    show(): void {}
    triggerDomReady(): void { this.domReadyHandler?.() }
    navigate(url: string): void { this.navigateHandler?.({ preventDefault: () => {} }, url) }
  }
  return {
    BrowserWindow: MockBrowserWindow,
    setLoadError(error: Error | null) { loadError = error },
    setMeasurementError(error: Error | null) { measurementError = error },
    getLastWindow() { return lastWindow },
    getWindowCount() { return windowCount },
  }
})
const logError = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ BrowserWindow: electronMock.BrowserWindow, nativeTheme: { shouldUseDarkColors: false } }))
vi.mock('@main/io/logger', () => ({ log: { error: logError } }))

import { showPlainMessageDialog } from '@main/plain-message-dialog'

describe('plain message dialog settlement', () => {
  beforeEach(() => {
    electronMock.setLoadError(null)
    electronMock.setMeasurementError(null)
    logError.mockClear()
  })

  it('settles when the authored document cannot load', async () => {
    electronMock.setLoadError(new Error('EACCES /private/tmp/TAPEBOX-DIALOG-SENTINEL'))
    await expect(showPlainMessageDialog({ language: 'en', title: 'Notice', message: 'Safe copy', closeLabel: 'OK' })).resolves.toBeNull()
    expect(logError).toHaveBeenCalledWith('message dialog load failed', expect.any(Object))
  })

  it('settles when natural measurement rejects before the window is shown', async () => {
    electronMock.setMeasurementError(new Error('renderer gone'))
    const pending = showPlainMessageDialog({ language: 'en', title: 'Notice', message: 'Safe copy', closeLabel: 'OK' })
    electronMock.getLastWindow()?.triggerDomReady()
    await expect(pending).resolves.toBeNull()
  })

  const choices = {
    language: 'en',
    title: 'Library changes could not be saved',
    message: 'm',
    closeLabel: 'Cancel',
    actions: [{ id: 'retry', label: 'Try again' }, { id: 'quit-anyway', label: 'Quit anyway', danger: true }],
  }

  it('resolves with the chosen action, and with null for the dismiss button or an unknown one', async () => {
    const chosen = showPlainMessageDialog(choices)
    electronMock.getLastWindow()?.navigate('https://tapebox-dialog.invalid/choose/quit-anyway')
    await expect(chosen).resolves.toBe('quit-anyway')

    const dismissed = showPlainMessageDialog(choices)
    electronMock.getLastWindow()?.navigate('https://tapebox-dialog.invalid/close')
    await expect(dismissed).resolves.toBeNull()

    const unknown = showPlainMessageDialog(choices)
    electronMock.getLastWindow()?.navigate('https://tapebox-dialog.invalid/choose/delete-everything')
    await expect(unknown).resolves.toBeNull()
  })

  it('closes as dismissed when its signal aborts, and never opens for an aborted one', async () => {
    const controller = new AbortController()
    const pending = showPlainMessageDialog({ ...choices, signal: controller.signal })
    const win = electronMock.getLastWindow()!
    controller.abort()
    await expect(pending).resolves.toBeNull()
    expect(win.isDestroyed()).toBe(true)

    const before = electronMock.getWindowCount()
    await expect(showPlainMessageDialog({ ...choices, signal: controller.signal })).resolves.toBeNull()
    expect(electronMock.getWindowCount()).toBe(before)
  })
})
