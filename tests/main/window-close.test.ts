import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// Closing the main window ends the app on every platform (window-conventions), and
// the quit asks the main renderer before discarding its drafts
// (unsaved-edits-conventions). A minimized window is not brought back to ask.

const handlers = vi.hoisted(() => new Map<string, (request: unknown, event: unknown) => unknown>())
vi.mock('@main/ipc/handle', () => ({ handle: (channel: string, handler: (request: unknown, event: unknown) => unknown) => { handlers.set(channel, handler) } }))
import { configureWindowClose, registerDraftAnswers, settleWindowDrafts } from '@main/window-close'

class Contents extends EventEmitter {
  send = vi.fn()
  destroyed = false
  isDestroyed() { return this.destroyed }
}

class Window extends EventEmitter {
  webContents = new Contents()
  visible = true
  minimized = false
  isDestroyed() { return false }
  isVisible() { return this.visible }
  isMinimized() { return this.minimized }
}

beforeAll(() => registerDraftAnswers())

const answer = (sender: unknown, requestId: number, dirty: boolean, discard: boolean) =>
  handlers.get('app:quitDraftsAnswer')!({ requestId, dirty, discard }, { sender })

function asked(win: Window): { requestId: number; ask: boolean } {
  const [channel, request] = win.webContents.send.mock.lastCall!
  expect(channel).toBe('app:quitDraftsRequested')
  return request as { requestId: number; ask: boolean }
}

describe('closing the main window', () => {
  it('keeps the window and starts the quit, on every platform', () => {
    const win = new Window()
    const quit = vi.fn()
    configureWindowClose(win as unknown as BrowserWindow, quit)
    const event = { preventDefault: vi.fn() }
    win.emit('close', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })
})

describe('a quit and the main window\'s drafts', () => {
  const standalone = vi.fn(async () => true)
  const settle = (win: Window | null, signal = new AbortController().signal) =>
    settleWindowDrafts(win as unknown as BrowserWindow, signal, standalone)

  it('goes on at once when the window holds no drafts', async () => {
    const win = new Window()
    const result = settle(win)
    const { requestId, ask } = asked(win)
    expect(ask).toBe(true)
    await answer(win.webContents, requestId, false, true)
    await expect(result).resolves.toBe(true)
  })

  it('follows the choice the showing window asked for', async () => {
    const win = new Window()
    const kept = settle(win)
    await answer(win.webContents, asked(win).requestId, true, false)
    await expect(kept).resolves.toBe(false)

    const discarded = settle(win)
    await answer(win.webContents, asked(win).requestId, true, true)
    await expect(discarded).resolves.toBe(true)
  })

  it('asks in a standalone dialog for a minimized window, which only reports its drafts', async () => {
    const win = new Window()
    win.minimized = true
    standalone.mockResolvedValueOnce(false)
    const result = settle(win)
    const { requestId, ask } = asked(win)
    expect(ask).toBe(false)
    await answer(win.webContents, requestId, true, false)
    await expect(result).resolves.toBe(false)
    expect(standalone).toHaveBeenCalledOnce()
  })

  it('ignores an answer from another window', async () => {
    const win = new Window()
    let settled = false
    const result = settle(win).then((value) => { settled = true; return value })
    const { requestId } = asked(win)
    await answer(new Contents(), requestId, true, true)
    await Promise.resolve()
    expect(settled).toBe(false)
    await answer(win.webContents, requestId, true, false)
    await expect(result).resolves.toBe(false)
  })

  it('goes on when the session ends, the page is gone, or there is no window', async () => {
    const ending = new AbortController()
    const win = new Window()
    const ended = settle(win, ending.signal)
    ending.abort()
    await expect(ended).resolves.toBe(true)

    const crashed = new Window()
    const gone = settle(crashed)
    crashed.webContents.emit('render-process-gone')
    await expect(gone).resolves.toBe(true)

    await expect(settle(null)).resolves.toBe(true)
  })
})
