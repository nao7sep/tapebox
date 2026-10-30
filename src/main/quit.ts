/**
 * Every quit path in one place (unsaved-edits-conventions, Quitting). The menu
 * Quit, Cmd+Q, the Dock's Quit and closing the main window on every platform
 * (window-conventions) all arrive as before-quit and are the user's. A user's
 * quit first asks before discarding the main window's drafts and before
 * stopping app-owned work that is still running; Cancel leaves everything as it
 * was. An OS logout, restart or
 * shutdown is a session end: macOS and Linux mark it with powerMonitor's
 * 'shutdown' before their quit arrives, and Windows raises the main window's
 * 'session-end' and never a quit event, so that handler closes the records and
 * exits before it returns; the catalog keeps its last committed state.
 *
 * The library catalog is the user's own work. A user's quit saves it before
 * anything is stopped, so a failed save can cancel the quit with the app still
 * whole: the user chooses Cancel, Retry or Quit anyway. Stopping work can
 * change the catalog, so its final save has the same choices. A session end
 * never asks.
 */

import { describeError } from '@shared/error'

/** What the user chose after a failed library save; 'cancel' is also the dialog closed. */
export type QuitChoice = 'cancel' | 'retry' | 'quit-anyway'

/** The one exit deadline, in ms, for every quit, within the 5 s Windows gives a
 * session end. It is fixed when the quit begins, and every step draws on what
 * remains of it. A question the quit asks pauses it: the deadline starts again
 * when the answer arrives (or a session end closes the question). */
export const EXIT_DEADLINE_MS = 4_000

/** How long powerMonitor's 'shutdown' marks the session as ending when no quit
 * follows it. Electron reports no cancelled logout (another app can veto it), so
 * after this window a quit is the user's again and asks about a failed save. Too
 * short a window could put that question in front of a real logout and block it;
 * too long only skips the question for a quit soon after a cancelled logout.
 * Shared with BigMouth and ZipKit. */
export const SESSION_END_MARK_MS = 60_000

export interface QuitSteps {
  /** Asks about drafts the quit would discard and work it would stop; resolves
   * false when the user keeps them. An abort of `signal` (a session end) ends
   * the questions, and the quit goes on. */
  confirm(signal: AbortSignal): Promise<boolean>
  /** Saves the library catalog; resolves true once it is on disk. */
  saveCollection(): Promise<boolean>
  /** Shows the failed library save and resolves with the user's choice. An abort
   * of `signal` closes it as cancelled. */
  ask(signal: AbortSignal): Promise<QuitChoice>
  /** The user cancelled the quit: the app carries on. */
  resume(): void
  /** Stops downloads, tool installs, scans and other work in flight. */
  stopWork(): Promise<void>
  /** Saves the layout (view state). */
  saveLayout(): Promise<void>
  /** Stops the media server and closes the backup history and records; a
   * session end skips the backups still waiting. */
  close(sessionEnding: boolean): Promise<void>
  /** Closes the records synchronously within `remainingMs`, for a Windows
   * session end, after which the process may be ended at any time. The catalog
   * keeps its last committed state; nothing writes it synchronously. */
  endNow(remainingMs: number): void
  warn(message: string, details: Record<string, unknown>): void
  exit(forced?: boolean): void
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
   * a running quit closes its question and ends within the deadline. With no quit
   * running, the mark applies to a quit that arrives within
   * {@link SESSION_END_MARK_MS}. */
  markSessionEnd(): void
  /** The Windows main window's 'session-end': close the records and exit before returning. */
  endSessionNow(): void
}

export function createQuit(steps: QuitSteps): Quit {
  let running = false
  let sessionEnding = false
  let exited = false
  let allowUnsaved = false
  /** A stop, layout or close step outlived the deadline and may still be running. */
  let forced = false
  /** The last library save outlived the deadline. A later successful save clears
   * it: catalog writes run in order, so that one settled first. */
  let collectionSaveUnsettled = false
  let deadlineAt = 0
  let markTimer: ReturnType<typeof setTimeout> | null = null
  let question: AbortController | null = null

  const exit = (force = forced || collectionSaveUnsettled): void => {
    if (exited) return
    exited = true
    if (markTimer) clearTimeout(markTimer)
    steps.exit(force)
  }

  const clearMarkTimer = (): void => {
    if (markTimer) { clearTimeout(markTimer); markTimer = null }
  }

  const restartDeadline = (): void => { deadlineAt = Date.now() + EXIT_DEADLINE_MS }
  const remaining = (): number => Math.max(0, deadlineAt - Date.now())

  /** Asks one question with the deadline paused; it starts again on the answer. */
  async function asking<T>(ask: (signal: AbortSignal) => Promise<T>): Promise<T> {
    question = new AbortController()
    try {
      return await ask(question.signal)
    } finally {
      question = null
      restartDeadline()
    }
  }

  function warnUnsettled(step: string, settled: Settled<unknown>): void {
    if (settled.outcome === 'timeout') steps.warn(`${step} did not finish before the exit deadline`, { deadlineMs: EXIT_DEADLINE_MS })
    else if (settled.outcome === 'failed') steps.warn(`${step} failed at quit`, { error: describeError(settled.error) })
  }

  async function step(name: string, work: Promise<unknown>): Promise<void> {
    const settled = await within(work, remaining())
    if (settled.outcome === 'timeout') forced = true
    warnUnsettled(name, settled)
  }

  /** Saves the library until it is saved, the user decides, or the session ends.
   * Resolves false when the user cancelled the quit. */
  async function saveOrAsk(): Promise<boolean> {
    for (;;) {
      const saved = await within(steps.saveCollection(), remaining())
      collectionSaveUnsettled = saved.outcome === 'timeout'
      if (saved.outcome === 'done' && saved.value) return true
      warnUnsettled('the library save', saved)
      if (sessionEnding) {
        steps.warn('quitting for the session end without the library save', {})
        return true
      }
      if (allowUnsaved) return true
      let choice: QuitChoice
      try {
        choice = await asking(steps.ask)
      } catch (error) {
        steps.warn('the failed-save question could not be shown; cancelling the quit', { error: describeError(error) })
        choice = 'cancel'
      }
      // A session end closed the question: it never asks, and goes on.
      if (sessionEnding) return true
      if (choice === 'retry') continue
      if (choice === 'quit-anyway') {
        allowUnsaved = true
        steps.warn('quit anyway without the library save', {})
        return true
      }
      return false
    }
  }

  /** The user's go-ahead for what the quit ends. A session end never asks. */
  async function confirmed(): Promise<boolean> {
    if (sessionEnding) return true
    try {
      return await asking(steps.confirm) || sessionEnding
    } catch (error) {
      if (sessionEnding) return true
      steps.warn('the quit questions could not be shown; cancelling the quit', { error: describeError(error) })
      return false
    }
  }

  async function run(): Promise<void> {
    if (!(await confirmed()) || !(await saveOrAsk())) {
      running = false
      steps.resume()
      return
    }
    await step('stopping work in flight', steps.stopWork())
    // Finalized downloads may have changed the catalog while work stopped.
    const library = saveOrAsk()
    const layout = steps.saveLayout()
    if (!(await library)) {
      running = false
      steps.resume()
      return
    }
    await step('the layout save', layout)
    await step('closing the stores', steps.close(sessionEnding))
    exit()
  }

  return {
    beforeQuit(event) {
      event.preventDefault()
      if (running || exited) return
      running = true
      allowUnsaved = false
      forced = false
      collectionSaveUnsettled = false
      restartDeadline()
      // The session end this quit belongs to no longer expires.
      clearMarkTimer()
      // A step that throws past the deadline still exits: quit must never hang.
      void run().catch((error: unknown) => {
        steps.warn('the quit failed; exiting', { error: describeError(error) })
        exit(true)
      })
    },
    markSessionEnd() {
      if (!running) {
        // Mark the session as ending for a quit that follows within the window.
        sessionEnding = true
        clearMarkTimer()
        markTimer = setTimeout(() => {
          markTimer = null
          if (!running) sessionEnding = false
        }, SESSION_END_MARK_MS)
        return
      }
      sessionEnding = true
      question?.abort()
    },
    endSessionNow() {
      if (exited) return
      sessionEnding = true
      // This handler begins a quit of its own, or closes a running quit's
      // question, which restarts the deadline; otherwise it draws on what remains.
      if (!running || question) restartDeadline()
      question?.abort()
      try {
        steps.endNow(remaining())
      } catch (error) {
        steps.warn('the session-end close failed', { error: describeError(error) })
      }
      exit(true)
    },
  }
}
