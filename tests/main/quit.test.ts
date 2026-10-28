import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQuit, EXIT_DEADLINE_MS, SESSION_END_MARK_MS, type QuitChoice, type QuitSteps } from '@main/quit'

function quitEvent() {
  return { preventDefault: vi.fn() }
}

const never = <T>() => new Promise<T>(() => {})

/** Steps that record their order; each can be replaced per test. */
function makeSteps(overrides: Partial<QuitSteps> = {}) {
  const order: string[] = []
  const questions: { signal: AbortSignal; answer: (choice: QuitChoice) => void }[] = []
  const steps: QuitSteps = {
    confirm: vi.fn(async () => true),
    saveLibrary: vi.fn(async () => { order.push('saveLibrary'); return true }),
    ask: vi.fn((signal: AbortSignal) => new Promise<QuitChoice>((resolve) => {
      order.push('ask')
      questions.push({ signal, answer: resolve })
      signal.addEventListener('abort', () => resolve('cancel'))
    })),
    resume: vi.fn(() => { order.push('resume') }),
    stopWork: vi.fn(async () => { order.push('stopWork') }),
    saveLayout: vi.fn(async () => { order.push('saveLayout') }),
    close: vi.fn(async () => { order.push('close') }),
    endNow: vi.fn(() => { order.push('endNow') }),
    warn: vi.fn(),
    exit: vi.fn(() => { order.push('exit') }),
    ...overrides,
  }
  return { steps, order, questions }
}

describe('quit', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('saves the library before stopping anything, then saves again, closes and exits once', async () => {
    const { steps, order } = makeSteps()
    const quit = createQuit(steps)
    const first = quitEvent()
    quit.beforeQuit(first)
    const second = quitEvent()
    quit.beforeQuit(second)
    await vi.runAllTimersAsync()

    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(second.preventDefault).toHaveBeenCalledOnce()
    expect(order).toEqual(['saveLibrary', 'stopWork', 'saveLibrary', 'saveLayout', 'close', 'exit'])
    expect(steps.exit).toHaveBeenCalledWith(false)
    expect(steps.ask).not.toHaveBeenCalled()

    const late = quitEvent()
    quit.beforeQuit(late)
    await vi.runAllTimersAsync()
    expect(late.preventDefault).toHaveBeenCalledOnce()
    expect(steps.exit).toHaveBeenCalledOnce()
  })

  // A user's quit asks about drafts it would discard and work it would stop before
  // anything else (unsaved-edits-conventions); a session end never asks.
  it('asks first, and Cancel resumes with nothing saved or stopped', async () => {
    const confirm = vi.fn(async () => false)
    const { steps, order } = makeSteps({ confirm })
    createQuit(steps).beforeQuit(quitEvent())
    await vi.runAllTimersAsync()
    expect(confirm).toHaveBeenCalledOnce()
    expect(order).toEqual(['resume'])
    expect(steps.exit).not.toHaveBeenCalled()
  })

  it('cancels the quit when its questions cannot be shown', async () => {
    const { steps, order } = makeSteps({ confirm: vi.fn(async () => { throw new Error('no dialog') }) })
    createQuit(steps).beforeQuit(quitEvent())
    await vi.runAllTimersAsync()
    expect(order).toEqual(['resume'])
    expect(steps.warn).toHaveBeenCalledWith('the quit questions could not be shown; cancelling the quit', expect.anything())
  })

  it('closes its questions and goes on when the session ends while they are open', async () => {
    let signal!: AbortSignal
    const confirm = vi.fn((s: AbortSignal) => new Promise<boolean>((resolve) => {
      signal = s
      s.addEventListener('abort', () => resolve(false))
    }))
    const { steps } = makeSteps({ confirm })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(0)
    quit.markSessionEnd()
    expect(signal.aborted).toBe(true)
    await vi.runAllTimersAsync()
    expect(steps.resume).not.toHaveBeenCalled()
    expect(steps.exit).toHaveBeenCalledOnce()
  })

  it('never asks during a session end', async () => {
    const { steps } = makeSteps()
    const quit = createQuit(steps)
    quit.markSessionEnd()
    quit.beforeQuit(quitEvent())
    await vi.runAllTimersAsync()
    expect(steps.confirm).not.toHaveBeenCalled()
    expect(steps.exit).toHaveBeenCalledOnce()
  })

  it('cancels the quit when the library save fails and the user cancels, with nothing stopped', async () => {
    const saveLibrary = vi.fn(async () => false)
    const { steps, questions } = makeSteps({ saveLibrary })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(0)

    expect(questions).toHaveLength(1)
    questions[0]!.answer('cancel')
    await vi.runAllTimersAsync()
    expect(steps.resume).toHaveBeenCalledOnce()
    expect(steps.stopWork).not.toHaveBeenCalled()
    expect(steps.exit).not.toHaveBeenCalled()

    // The app carries on, and a later quit runs again.
    saveLibrary.mockResolvedValue(true)
    quit.beforeQuit(quitEvent())
    await vi.runAllTimersAsync()
    expect(steps.exit).toHaveBeenCalledOnce()
  })

  it('keeps the final catalog save required after work changes it', async () => {
    const saveLibrary = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true)
    const { steps, questions } = makeSteps({ saveLibrary })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(0)
    expect(steps.stopWork).toHaveBeenCalledOnce()
    expect(steps.close).not.toHaveBeenCalled()
    expect(steps.exit).not.toHaveBeenCalled()
    questions[0]!.answer('retry')
    await vi.runAllTimersAsync()
    expect(saveLibrary).toHaveBeenCalledTimes(3)
    expect(steps.exit).toHaveBeenCalledOnce()
  })

  it.each(['cancel', 'failed-question'] as const)('resumes after a final-save %s without closing stores', async (choice) => {
    const saveLibrary = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const { steps, questions } = makeSteps({ saveLibrary })
    if (choice === 'failed-question') steps.ask = vi.fn(async () => { throw new Error('dialog failed') })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(0)
    if (choice === 'cancel') questions[0]!.answer('cancel')
    await vi.runAllTimersAsync()
    expect(steps.resume).toHaveBeenCalledOnce()
    expect(steps.close).not.toHaveBeenCalled()
    expect(steps.exit).not.toHaveBeenCalled()
    if (choice === 'failed-question') expect(steps.warn).toHaveBeenCalledWith(
      'the failed-save question could not be shown; cancelling the quit',
      { error: expect.objectContaining({ stack: expect.stringContaining('dialog failed') }) },
    )
  })

  it('cancels safely when the initial failed-save question rejects', async () => {
    const { steps } = makeSteps({ saveLibrary: vi.fn(async () => false), ask: vi.fn(async () => { throw new Error('dialog failed') }) })
    createQuit(steps).beforeQuit(quitEvent())
    await vi.runAllTimersAsync()
    expect(steps.resume).toHaveBeenCalledOnce()
    expect(steps.stopWork).not.toHaveBeenCalled()
    expect(steps.exit).not.toHaveBeenCalled()
  })

  it('retries the save and quits once it succeeds', async () => {
    const saveLibrary = vi.fn(async () => false)
    const { steps, questions, order } = makeSteps({ saveLibrary })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(0)

    saveLibrary.mockResolvedValue(true)
    questions[0]!.answer('retry')
    await vi.runAllTimersAsync()
    expect(saveLibrary).toHaveBeenCalledTimes(3)
    expect(order).toEqual(['ask', 'stopWork', 'saveLayout', 'close', 'exit'])
  })

  it('quits anyway when the user chooses so, and logs it', async () => {
    const { steps, questions } = makeSteps({ saveLibrary: vi.fn(async () => false) })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(0)

    questions[0]!.answer('quit-anyway')
    await vi.runAllTimersAsync()
    expect(steps.warn).toHaveBeenCalledWith('quit anyway without the library save', {})
    expect(steps.stopWork).toHaveBeenCalledOnce()
    expect(steps.exit).toHaveBeenCalledOnce()
  })

  it('treats a library save that stalls past the deadline as failed and asks', async () => {
    const { steps } = makeSteps({ saveLibrary: vi.fn(() => never<boolean>()) })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())

    await vi.advanceTimersByTimeAsync(EXIT_DEADLINE_MS - 1)
    expect(steps.ask).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(steps.ask).toHaveBeenCalledOnce()
    expect(steps.warn).toHaveBeenCalledWith('the library save did not finish before the exit deadline', { deadlineMs: EXIT_DEADLINE_MS })
  })

  it('clears the forced-exit decision after a timed-out quit is cancelled', async () => {
    const saveLibrary = vi.fn().mockImplementationOnce(() => never<boolean>()).mockResolvedValue(true)
    const { steps, questions } = makeSteps({ saveLibrary })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(EXIT_DEADLINE_MS)
    questions[0]!.answer('cancel')
    await vi.advanceTimersByTimeAsync(0)
    expect(steps.exit).not.toHaveBeenCalled()
    quit.beforeQuit(quitEvent())
    await vi.runAllTimersAsync()
    expect(steps.exit).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('exits normally once a retried library save succeeds after one timed out', async () => {
    const saveLibrary = vi.fn().mockImplementationOnce(() => never<boolean>()).mockResolvedValue(true)
    const { steps, questions } = makeSteps({ saveLibrary })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(EXIT_DEADLINE_MS)
    questions[0]!.answer('retry')
    await vi.runAllTimersAsync()
    expect(steps.exit).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('still forces the exit when work outlived its stop bound, though every save succeeded', async () => {
    const { steps } = makeSteps({ stopWork: vi.fn(() => never<void>()) })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())
    await vi.runAllTimersAsync()
    expect(steps.exit).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('forgets a shutdown signal that no quit followed, so a later quit asks on a failed save', async () => {
    const { steps } = makeSteps({ saveLibrary: vi.fn(async () => false) })
    const quit = createQuit(steps)
    quit.markSessionEnd()
    await vi.advanceTimersByTimeAsync(SESSION_END_MARK_MS)
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(0)
    expect(steps.ask).toHaveBeenCalledOnce()
    expect(steps.exit).not.toHaveBeenCalled()
  })

  it('keeps a quit soon after a shutdown signal a session end, even past the window', async () => {
    const { steps } = makeSteps({ saveLibrary: vi.fn(async () => false), stopWork: vi.fn(() => never<void>()) })
    const quit = createQuit(steps)
    quit.markSessionEnd()
    await vi.advanceTimersByTimeAsync(SESSION_END_MARK_MS - 1)
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(EXIT_DEADLINE_MS)
    expect(steps.ask).not.toHaveBeenCalled()
    expect(steps.exit).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('ends a user quit whose every later step stalls at the one exit deadline', async () => {
    const { steps } = makeSteps({
      stopWork: vi.fn(() => never<void>()),
      saveLayout: vi.fn(() => never<void>()),
      close: vi.fn(() => never<void>()),
    })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(EXIT_DEADLINE_MS - 1)
    expect(steps.exit).not.toHaveBeenCalled()
    // The steps after the deadline get no time of their own.
    await vi.runAllTimersAsync()
    expect(steps.exit).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('restarts the deadline when the failed-save question is answered', async () => {
    const saveLibrary = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const { steps, questions } = makeSteps({ saveLibrary, stopWork: vi.fn(() => never<void>()) })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(EXIT_DEADLINE_MS * 3)
    expect(steps.stopWork).not.toHaveBeenCalled()
    questions[0]!.answer('retry')
    await vi.advanceTimersByTimeAsync(EXIT_DEADLINE_MS - 1)
    expect(steps.exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(steps.exit).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('never asks during a session end, and exits at the deadline when every step stalls', async () => {
    const { steps } = makeSteps({
      saveLibrary: vi.fn(() => never<boolean>()),
      stopWork: vi.fn(() => never<void>()),
      saveLayout: vi.fn(() => never<void>()),
      close: vi.fn(() => never<void>()),
    })
    const quit = createQuit(steps)
    quit.markSessionEnd()
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(EXIT_DEADLINE_MS - 1)
    expect(steps.exit).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(steps.ask).not.toHaveBeenCalled()
    expect(steps.exit).toHaveBeenCalledOnce()
  })

  it('closes an open question as cancelled when the session ends, then quits without asking', async () => {
    const saveLibrary = vi.fn(async () => false)
    const { steps, questions } = makeSteps({ saveLibrary })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(0)
    expect(questions[0]!.signal.aborted).toBe(false)

    quit.markSessionEnd()
    expect(questions[0]!.signal.aborted).toBe(true)
    await vi.runAllTimersAsync()
    expect(steps.ask).toHaveBeenCalledOnce()
    expect(steps.resume).not.toHaveBeenCalled()
    expect(steps.stopWork).toHaveBeenCalledOnce()
    expect(steps.exit).toHaveBeenCalledOnce()
  })

  it('exits at the same deadline when a session end reaches a user quit stuck in a long step', async () => {
    const { steps } = makeSteps({ stopWork: vi.fn(() => never<void>()) })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(0)
    quit.markSessionEnd()
    await vi.advanceTimersByTimeAsync(EXIT_DEADLINE_MS)
    expect(steps.exit).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('closes and exits synchronously on a Windows session end, before the handler returns', () => {
    const { steps, order } = makeSteps()
    const quit = createQuit(steps)
    quit.endSessionNow()
    expect(order).toEqual(['endNow', 'exit'])
    expect(steps.endNow).toHaveBeenCalledWith(EXIT_DEADLINE_MS)
    expect(steps.exit).toHaveBeenCalledWith(true)
    expect(steps.ask).not.toHaveBeenCalled()
  })

  it('still exits on a Windows session end whose close throws, and logs it', () => {
    const { steps } = makeSteps({ endNow: vi.fn(() => { throw new Error('EROFS') }) })
    const quit = createQuit(steps)
    quit.endSessionNow()
    expect(steps.warn).toHaveBeenCalledWith('the session-end close failed', expect.any(Object))
    expect(steps.exit).toHaveBeenCalledOnce()
  })

  it('closes an open question and exits when Windows ends the session during a user quit', async () => {
    const { steps, questions } = makeSteps({ saveLibrary: vi.fn(async () => false) })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())
    await vi.advanceTimersByTimeAsync(0)

    quit.endSessionNow()
    expect(questions[0]!.signal.aborted).toBe(true)
    expect(steps.endNow).toHaveBeenCalledOnce()
    expect(steps.exit).toHaveBeenCalledOnce()
    await vi.runAllTimersAsync()
    expect(steps.resume).not.toHaveBeenCalled()
    expect(steps.exit).toHaveBeenCalledOnce()
  })

  it('still exits when a step throws outside its bound', async () => {
    const { steps } = makeSteps({ resume: vi.fn() })
    steps.stopWork = vi.fn(() => { throw new Error('sync throw') })
    const quit = createQuit(steps)
    quit.beforeQuit(quitEvent())
    await vi.runAllTimersAsync()
    expect(steps.warn).toHaveBeenCalledWith('the quit failed; exiting', expect.any(Object))
    expect(steps.exit).toHaveBeenCalledWith(true)
    expect(steps.exit).toHaveBeenCalledOnce()
  })
})
