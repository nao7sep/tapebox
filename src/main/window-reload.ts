import type { BrowserWindow } from 'electron'

/** Reload replaces only a renderer. Quit supersedes its consent request, and a
 * late answer must never replace a page during shutdown or a cancelled quit. */
export function createWindowReload(
  confirm: (window: BrowserWindow, signal: AbortSignal) => Promise<boolean>,
  failed: (error: unknown) => void,
) {
  let quitting = false
  const requests = new Map<BrowserWindow, AbortController>()
  function cancelPending(): void {
    for (const controller of requests.values()) controller.abort()
    requests.clear()
  }
  return {
    cancelPending,
    async request(window: BrowserWindow, force: boolean): Promise<void> {
      if (quitting || window.isDestroyed() || requests.has(window)) return
      const controller = new AbortController()
      requests.set(window, controller)
      try {
        if (!await confirm(window, controller.signal)) return
        if (controller.signal.aborted || quitting || window.isDestroyed() || window.webContents.isDestroyed()) return
        if (force) window.webContents.reloadIgnoringCache()
        else window.webContents.reload()
      } catch (error) { failed(error) }
      finally { if (requests.get(window) === controller) requests.delete(window) }
    },
    beginQuit(): void {
      quitting = true
      cancelPending()
    },
    resume(): void { quitting = false },
  }
}
