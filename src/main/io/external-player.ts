import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const LAUNCH_TIMEOUT_MS = 5_000

/** Wait for the OS handoff, never for the independently running player to exit. */
export async function openExternalPlayer(player: string, file: string, platform = process.platform): Promise<void> {
  if (platform === 'darwin') {
    // `open` is a short handoff helper; its exit status reports an unavailable app.
    await execFileAsync('/usr/bin/open', ['-a', player, file], {
      timeout: LAUNCH_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    return
  }

  const child = spawn(player, [file], { detached: true, stdio: 'ignore', windowsHide: true })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('The external player did not start in time.')), LAUNCH_TIMEOUT_MS)
  try {
    await once(child, 'spawn', { signal: controller.signal })
  } catch (error) {
    // `once` removed its error listener. A failed kill or late launch failure
    // must not escape the failed handoff as an uncaught process error.
    const cleanupError = (): void => {}
    child.on('error', cleanupError)
    child.once('close', () => child.off('error', cleanupError))
    try { child.kill('SIGKILL') } catch { /* Preserve the handoff's original failure. */ }
    throw error
  } finally {
    clearTimeout(timeout)
  }
  child.unref()
}
