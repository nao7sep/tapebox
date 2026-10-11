import { EventEmitter } from 'node:events'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: ipc }))
vi.mock('@main/io/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }))
import { configureWindowClose } from '@main/window-close'

class Window extends EventEmitter {
  webContents = { send: vi.fn() }
  destroyed = false
  isDestroyed() { return this.destroyed }
  close() {
    const event = { preventDefault: vi.fn() }
    this.emit('close', event)
    if (!event.preventDefault.mock.calls.length) {
      this.destroyed = true
      this.emit('closed')
    }
  }
}

beforeEach(() => vi.clearAllMocks())

describe('Mac workspace close', () => {
  it('keeps the window alive until its own renderer approves a requested close', async () => {
    const win = new Window()
    configureWindowClose(win as unknown as BrowserWindow, 'darwin')
    const approve = ipc.handle.mock.calls[0]![1] as (event: Partial<IpcMainInvokeEvent>, value: undefined) => Promise<unknown>
    const sender = win.webContents as unknown as IpcMainInvokeEvent['sender']
    await approve({ sender }, undefined)
    expect(win.destroyed).toBe(false)

    win.close()
    win.close()
    expect(win.destroyed).toBe(false)
    expect(win.webContents.send).toHaveBeenCalledWith('app:windowCloseRequested', null)
    await approve({ sender: {} as IpcMainInvokeEvent['sender'] }, undefined)
    expect(win.destroyed).toBe(false)
    await approve({ sender }, undefined)
    expect(win.destroyed).toBe(true)
    expect(ipc.removeHandler).toHaveBeenCalledWith('app:closeWindow')
  })

  it.each(['win32', 'linux'] as const)('retains native close on %s', (platform) => {
    const win = new Window()
    configureWindowClose(win as unknown as BrowserWindow, platform)
    win.close()
    expect(win.destroyed).toBe(true)
    expect(win.webContents.send).not.toHaveBeenCalled()
    expect(ipc.handle).not.toHaveBeenCalled()
  })

  it('removes its approver when destroyed and ignores a late reply', async () => {
    const win = new Window()
    configureWindowClose(win as unknown as BrowserWindow, 'darwin')
    win.close()
    const approve = ipc.handle.mock.calls[0]![1] as (event: Partial<IpcMainInvokeEvent>, value: undefined) => Promise<unknown>
    win.destroyed = true
    win.emit('closed')
    const close = vi.spyOn(win, 'close')
    await approve({ sender: win.webContents as unknown as IpcMainInvokeEvent['sender'] }, undefined)
    expect(close).not.toHaveBeenCalled()
    expect(ipc.removeHandler).toHaveBeenCalledWith('app:closeWindow')
  })
})
