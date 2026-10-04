import { describe, expect, it, vi } from 'vitest'
import { quitAfterShutdown } from '@main/quit-after-shutdown'

function quitEvent() {
  return { preventDefault: vi.fn() }
}

describe('quitAfterShutdown', () => {
  it('holds a second quit during shutdown and exits once, after shutdown settles', async () => {
    let finishShutdown!: () => void
    const shutdown = vi.fn(() => new Promise<void>((resolve) => { finishShutdown = resolve }))
    const exit = vi.fn()
    const beforeQuit = quitAfterShutdown(shutdown, exit)

    const first = quitEvent()
    beforeQuit(first)
    const second = quitEvent()
    beforeQuit(second)
    await Promise.resolve()

    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(second.preventDefault).toHaveBeenCalledOnce()
    expect(shutdown).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()

    finishShutdown()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce())
    const late = quitEvent()
    beforeQuit(late)
    expect(late.preventDefault).toHaveBeenCalledOnce()
    expect(shutdown).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
  })

  it('still exits when shutdown fails', async () => {
    const exit = vi.fn()
    const beforeQuit = quitAfterShutdown(() => Promise.reject(new Error('teardown failed')), exit)
    // The failure stays a rejection for the app's unhandled-rejection log.
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      beforeQuit(quitEvent())
      await vi.waitFor(() => expect(unhandled).toHaveBeenCalledOnce())
      expect(exit).toHaveBeenCalledOnce()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
