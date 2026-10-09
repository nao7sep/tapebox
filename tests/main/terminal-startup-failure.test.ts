import { describe, expect, it, vi } from 'vitest'
import { settleTerminalStartupFailure } from '@main/terminal-startup-failure'

describe('terminal startup settlement', () => {
  it('preserves both diagnostics and exits when its recovery window also rejects', async () => {
    const startup = new Error('EACCES /private/tmp/TAPEBOX_BOOTSTRAP')
    const dialog = new Error('ERR_FAILED /private/tmp/TAPEBOX_DIALOG')
    const log = { error: vi.fn() }
    const exit = vi.fn()

    await settleTerminalStartupFailure(startup, {
      log,
      notify: async () => { throw dialog },
      exit,
    })

    expect(log.error).toHaveBeenCalledTimes(2)
    expect(log.error.mock.calls[0][1]).toEqual(expect.objectContaining({
      error: expect.objectContaining({ message: expect.stringContaining('TAPEBOX_BOOTSTRAP') }),
    }))
    expect(log.error.mock.calls[1][1]).toEqual(expect.objectContaining({
      error: expect.objectContaining({ message: expect.stringContaining('TAPEBOX_DIALOG') }),
    }))
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('exits only after the notice has settled', async () => {
    const order: string[] = []
    let dismiss!: () => void
    const settled = settleTerminalStartupFailure(new Error('startup'), {
      log: { error: vi.fn() },
      notify: () => new Promise<void>((resolve) => { dismiss = () => { order.push('notice'); resolve() } }),
      exit: () => { order.push('exit') },
    })
    await Promise.resolve()
    expect(order).toEqual([])
    dismiss()
    await settled
    expect(order).toEqual(['notice', 'exit'])
  })
})
