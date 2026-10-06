/**
 * Every quit path in one place (unsaved-edits-conventions, Quitting). The menu
 * Quit, Cmd+Q, the Dock's Quit and closing the last window on Windows and Linux
 * all arrive as before-quit and are the user's. An OS logout, restart or
 * shutdown is a session end: macOS and Linux mark it with powerMonitor's
 * 'shutdown' before their quit arrives, and Windows raises the main window's
 * 'session-end' and never a quit event, so that handler saves and exits before
 * it returns.
 *
 * The library catalog is the user's own work. A user's quit saves it before
 * anything is stopped, so a failed save can cancel the quit with the app still
 * whole: the user chooses Cancel, Retry or Quit anyway. Everything after that
 * (stopping work, the final saves, closing the stores) is logged only. A session
 * end never asks.
 */

import { describeError } from '@shared/error'

/** Who started a quit. */
export type QuitOrigin = 'user' | 'session-end'

/** What the user chose after a failed library save; 'cancel' is also the dialog closed. */
export type QuitChoice = 'cancel' | 'retry' | 'quit-anyway'

export interface QuitBounds {
  /** Each save of the library catalog and of the layout. */
  save: number
  /** Stopping downloads, tool installs, scans and other work in flight. */
  stop: number
  /** Stopping the media server and closing the backup history and records. */
  close: number
}

/** Each step's bound, in ms, all under the 5 s Windows gives a session end. A
 * session end's steps add up to 3.5 s; a user's quit asks after at most 4 s. */
export const QUIT_BOUNDS_MS: Record<QuitOrigin, QuitBounds> = {
  user: { save: 4_000, stop: 4_500, close: 2_000 },
  'session-end': { save: 1_000, stop: 1_000, close: 500 },
}

/** A quit running during a session end exits this long after the session end
 * reached it, whatever step it is in. */
export const SESSION_END_LIMIT_MS = 4_000

export interface QuitSteps {
  /** Saves the library catalog; resolves true once it is on disk. */
  saveLibrary(): Promise<boolean>
  /** Shows the failed library save and resolves with the user's choice. An abort
   * of `signal` closes it as cancelled. */
  ask(signal: AbortSignal): Promise<QuitChoice>
  /** The user cancelled the quit: the app carries on. */
  resume(): void
  /** Stops downloads, tool installs, scans and other work in flight. */
  stopWork(): Promise<void>
  /** Saves the layout (view state). */
  saveLayout(): Promise<void>
  /** Stops the media server and closes the backup history and records. */
  close(): Promise<void>
  /** Writes a pending catalog save and closes the records synchronously, for a
   * Windows session end, after which the process may be ended at any time. */
  endNow(): void
  warn(message: string, details: Record<string, unknown>): void
  exit(): void
}

type Settled<T> =
  | { outcome: 'done'; value: T }
  | { outcome: 'failed'; error: unknown }
  | { outcome: 'timeout' }

/** Waits for `work` at most `ms`. A timeout does not stop the work. */
export function within<T>(work: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: 'timeout' }), ms)
  })
  const finished = work.then(
    (value): Settled<T> => ({ outcome: 'done', value }),
    (error: unknown): Settled<T> => ({ outcome: 'failed', error }),
  )
  return Promise.race([finished, expired]).finally(() => clearTimeout(timer))
}

export interface Quit {
  /** The before-quit handler. Every quit is held, including one that arrives
   * while a quit runs: Electron ends the process on any quit not prevented, and
   * only the exit after the steps settle ends it. */
  beforeQuit(event: { preventDefault: () => void }): void
  /** powerMonitor 'shutdown': the session is ending, so nothing asks again and
   * a running quit closes its question and ends within the limit. */
  markSessionEnd(): void
  /** The Windows main window's 'session-end': save, close and exit before returning. */
  endSessionNow(): void
}

export function createQuit(steps: QuitSteps): Quit {
  let running = false
  let sessionEnding = false
  let exited = false
  let limitTimer: ReturnType<typeof setTimeout> | null = null
  let question: AbortController | null = null

  const exit = (): void => {
    if (exited) return
    exited = true
    if (limitTimer) clearTimeout(limitTimer)
    steps.exit()
  }

  const bounds = (): QuitBounds => QUIT_BOUNDS_MS[sessionEnding ? 'session-end' : 'user']

  const startLimit = (): void => {
    if (limitTimer) return
    limitTimer = setTimeout(() => {
      steps.warn('the session ended before the quit finished; exiting', { limitMs: SESSION_END_LIMIT_MS })
      exit()
    }, SESSION_END_LIMIT_MS)
  }

  function warnUnsettled(step: string, settled: Settled<unknown>, boundMs: number): void {
    if (settled.outcome === 'timeout') steps.warn(`${step} did not finish within the quit bound`, { boundMs })
    else if (settled.outcome === 'failed') steps.warn(`${step} failed at quit`, { error: describeError(settled.error) })
  }

  /** Saves the library until it is saved, the user decides, or the session ends.
   * Resolves false when the user cancelled the quit. */
  async function saveOrAsk(): Promise<boolean> {
    for (;;) {
      const boundMs = bounds().save
      const saved = await within(steps.saveLibrary(), boundMs)
      if (saved.outcome === 'done' && saved.value) return true
      warnUnsettled('the library save', saved, boundMs)
      if (sessionEnding) {
        steps.warn('quitting for the session end without the library save', {})
        return true
      }
      question = new AbortController()
      const choice = await steps.ask(question.signal)
      question = null
      // A session end closed the question: it never asks, and goes on.
      if (sessionEnding) return true
      if (choice === 'retry') continue
      if (choice === 'quit-anyway') {
        steps.warn('quit anyway without the library save', {})
        return true
      }
      return false
    }
  }

  async function run(): Promise<void> {
    if (!(await saveOrAsk())) {
      running = false
      steps.resume()
      return
    }
    let b = bounds()
    warnUnsettled('stopping work in flight', await within(steps.stopWork(), b.stop), b.stop)
    // Stopping work can change the library, so it is saved again, logged only.
    b = bounds()
    const [library, layout] = await Promise.all([
      within(steps.saveLibrary(), b.save),
      within(steps.saveLayout(), b.save),
    ])
    if (library.outcome === 'done' && !library.value) steps.warn('the library save after stopping work failed', {})
    else warnUnsettled('the library save after stopping work', library, b.save)
    warnUnsettled('the layout save', layout, b.save)
    b = bounds()
    warnUnsettled('closing the stores', await within(steps.close(), b.close), b.close)
    exit()
  }

  return {
    beforeQuit(event) {
      event.preventDefault()
      if (running || exited) return
      running = true
      if (sessionEnding) startLimit()
      // A step that throws past its bound still exits: quit must never hang.
      void run().catch((error: unknown) => {
        steps.warn('the quit failed; exiting', { error: describeError(error) })
        exit()
      })
    },
    markSessionEnd() {
      if (sessionEnding) return
      sessionEnding = true
      if (!running) return
      startLimit()
      question?.abort()
    },
    endSessionNow() {
      if (exited) return
      sessionEnding = true
      question?.abort()
      try {
        steps.endNow()
      } catch (error) {
        steps.warn('the session-end save failed', { error: describeError(error) })
      }
      exit()
    },
  }
}
