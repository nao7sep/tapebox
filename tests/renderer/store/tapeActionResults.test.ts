import { beforeEach, describe, expect, it, vi } from 'vitest'

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: logError } }))

import { runTapeAction } from '@renderer/lib/runTapeAction'
import { useTapeActionResultsStore } from '@renderer/store/tapeActionResults'

beforeEach(() => {
  logError.mockReset()
  useTapeActionResultsStore.setState({ byTape: {} })
})

describe('direct tape action result ownership', () => {
  it('retains independent operations per tape without exposing hostile diagnostics', async () => {
    const hostile = new Error("Error invoking remote method: EACCES /private/tmp/TAPEBOX_ACTION_SENTINEL")
    await runTapeAction('tape-a', 'open', 'external player open failed', 'This tape could not be opened.', async () => { throw hostile })
    await runTapeAction('tape-a', 'reveal', 'tape reveal failed', 'This tape could not be shown in its folder.', async () => { throw hostile })
    await runTapeAction('tape-b', 'retry', 'download retry failed', 'This tape could not be queued again.', async () => { throw hostile })

    expect(useTapeActionResultsStore.getState().byTape).toEqual({
      'tape-a': {
        open: 'This tape could not be opened.',
        reveal: 'This tape could not be shown in its folder.',
      },
      'tape-b': { retry: 'This tape could not be queued again.' },
    })
    expect(JSON.stringify(useTapeActionResultsStore.getState().byTape)).not.toMatch(/EACCES|private\/tmp|SENTINEL|remote method/i)
    expect(JSON.stringify(logError.mock.calls)).toContain('TAPEBOX_ACTION_SENTINEL')
  })

  it('clears only the matching operation after a successful retry', async () => {
    useTapeActionResultsStore.getState().setResult('tape-a', 'open', 'Open failed')
    useTapeActionResultsStore.getState().setResult('tape-a', 'reveal', 'Reveal failed')

    await runTapeAction('tape-a', 'open', 'external player open failed', 'fallback', async () => {})

    expect(useTapeActionResultsStore.getState().byTape['tape-a']).toEqual({ reveal: 'Reveal failed' })
  })

  it('does not let an older rejection overwrite a newer success for the same action', async () => {
    let rejectOlder!: (error: Error) => void
    const older = new Promise<void>((_resolve, reject) => { rejectOlder = reject })
    const olderAttempt = runTapeAction('tape-a', 'open', 'open failed', 'Older failure', () => older)
    await runTapeAction('tape-a', 'open', 'open failed', 'Newer failure', async () => {})
    rejectOlder(new Error('stale failure'))
    await olderAttempt

    expect(useTapeActionResultsStore.getState().byTape['tape-a']).toBeUndefined()
    expect(logError).toHaveBeenCalledWith(
      'open failed',
      expect.objectContaining({ error: expect.objectContaining({ message: 'stale failure' }) }),
    )
  })

  it('does not let an older success clear a newer rejection for the same action', async () => {
    let resolveOlder!: () => void
    const older = new Promise<void>((resolve) => { resolveOlder = resolve })
    const olderAttempt = runTapeAction('tape-a', 'open', 'open failed', 'Older failure', () => older)
    const newerOutcome = await runTapeAction('tape-a', 'open', 'open failed', 'Newer failure', async () => {
      throw new Error('newer failed')
    })
    resolveOlder()

    await expect(olderAttempt).resolves.toBe('superseded')
    expect(newerOutcome).toBe('failed')
    expect(useTapeActionResultsStore.getState().byTape['tape-a']).toEqual({ open: 'Newer failure' })
  })
})
