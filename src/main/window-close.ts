import type { BrowserWindow } from 'electron'
import { handle } from './ipc/handle'
import { sendTo } from './ipc/events'

/** Closing the main window ends the app on every platform (window-conventions):
 * the close becomes a quit, whose owner asks about the window's drafts through
 * {@link settleWindowDrafts} while the window is still there. Quit and session
 * end exit through app.exit, which raises no close. */
export function configureWindowClose(win: BrowserWindow, quit: () => void): void {
  win.on('close', (event) => {
    event.preventDefault()
    quit()
  })
}

type DraftAnswer = { dirty: boolean; discard: boolean }
const pending = new Map<number, { sender: Electron.WebContents; settle: (answer: DraftAnswer) => void }>()
let nextRequest = 0

/** The main renderer answers a quit's draft question here. Only the window that
 * was asked can answer it. */
export function registerDraftAnswers(): void {
  handle('app:quitDraftsAnswer', ({ requestId, dirty, discard }, event) => {
    const request = pending.get(requestId)
    if (!request || request.sender !== event.sender) return
    pending.delete(requestId)
    request.settle({ dirty, discard })
  })
}

/**
 * Settles the drafts a quit would discard in the main window (unsaved-edits-
 * conventions): resolves true to go on, false when the user keeps editing. A
 * showing window asks in itself with its own Keep editing / Discard question; a
 * minimized one is not brought back, so its drafts are asked about in
 * `askStandalone` (window-conventions). A window that is gone, or whose page is,
 * holds no drafts, and an abort of `signal` (a session end) goes on.
 */
export function settleWindowDrafts(
  win: BrowserWindow | null,
  signal: AbortSignal,
  askStandalone: (signal: AbortSignal) => Promise<boolean>,
): Promise<boolean> {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed() || signal.aborted) return Promise.resolve(true)
  const showing = win.isVisible() && !win.isMinimized()
  const requestId = ++nextRequest
  const contents = win.webContents
  return new Promise<DraftAnswer>((resolve) => {
    const finish = (answer: DraftAnswer) => {
      pending.delete(requestId)
      signal.removeEventListener('abort', goOn)
      contents.off('render-process-gone', goOn)
      contents.off('destroyed', goOn)
      resolve(answer)
    }
    const goOn = () => finish({ dirty: false, discard: true })
    pending.set(requestId, { sender: contents, settle: finish })
    signal.addEventListener('abort', goOn)
    contents.once('render-process-gone', goOn)
    contents.once('destroyed', goOn)
    sendTo(contents, 'app:quitDraftsRequested', { requestId, ask: showing })
  }).then(async (answer) => {
    if (!answer.dirty || signal.aborted) return true
    return showing ? answer.discard : askStandalone(signal)
  })
}
