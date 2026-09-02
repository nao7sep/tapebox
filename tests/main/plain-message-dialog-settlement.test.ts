import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => {
  let loadError: Error | null = null
  let measurementError: Error | null = null
  let lastWindow: MockBrowserWindow | null = null
  class MockBrowserWindow {
    static getFocusedWindow = () => null
    private closedHandler: (() => void) | null = null
    private domReadyHandler: (() => void) | null = null
    private destroyed = false
    webContents = {
      on: vi.fn(),
      once: vi.fn((event: string, handler: () => void) => { if (event === 'dom-ready') this.domReadyHandler = handler }),
      executeJavaScript: vi.fn(() => measurementError ? Promise.reject(measurementError) : Promise.resolve(240)),
    }
    constructor(_options: unknown) { lastWindow = this }
    on(event: string, handler: () => void): void { if (event === 'closed') this.closedHandler = handler }
    loadURL(): Promise<void> { return loadError ? Promise.reject(loadError) : Promise.resolve() }
    isDestroyed(): boolean { return this.destroyed }
    close(): void { this.destroyed = true; this.closedHandler?.() }
    setContentSize(): void {}
    show(): void {}
    triggerDomReady(): void { this.domReadyHandler?.() }
  }
  return {
    BrowserWindow: MockBrowserWindow,
    setLoadError(error: Error | null) { loadError = error },
    setMeasurementError(error: Error | null) { measurementError = error },
    getLastWindow() { return lastWindow },
  }
})
const logError = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ BrowserWindow: electronMock.BrowserWindow }))
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
    await expect(showPlainMessageDialog({ title: 'Notice', message: 'Safe copy' })).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalledWith('message dialog load failed', expect.any(Object))
  })

  it('settles when natural measurement rejects before the window is shown', async () => {
    electronMock.setMeasurementError(new Error('renderer gone'))
    const pending = showPlainMessageDialog({ title: 'Notice', message: 'Safe copy' })
    electronMock.getLastWindow()?.triggerDomReady()
    await expect(pending).resolves.toBeUndefined()
  })
})
