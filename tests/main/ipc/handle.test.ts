import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('@main/io/logger', () => ({ log: { error: mocks.logError, warn: mocks.logWarn } }))

import { handle } from '@main/ipc/handle'
import { UserFacingError } from '@main/user-facing-error'
import { IpcCallError, unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'

type Callback = (_event: unknown, request: unknown) => Promise<IpcReply<unknown>>

function registered(): Callback {
  return mocks.handle.mock.calls.at(-1)![1] as Callback
}

describe('IPC failure boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('logs hostile diagnostics but replies with no copy of its own', async () => {
    const hostile = new Error('EACCES Error invoking remote method IPC /private/tmp/HOSTILE-SENTINEL', {
      cause: new TypeError('root cause'),
    })
    handle('settings:get', async () => { throw hostile })

    const reply = await registered()({}, undefined)
    expect(reply).toEqual({ ok: false, failure: { code: 'internal', userMessage: null } })
    expect(JSON.stringify(reply)).not.toContain('HOSTILE-SENTINEL')
    expect(() => unwrapIpcReply('settings:get', reply)).toThrow('The operation could not be completed.')

    expect(JSON.stringify(mocks.logError.mock.calls)).toContain('HOSTILE-SENTINEL')
    expect(JSON.stringify(mocks.logError.mock.calls)).toContain('root cause')
  })

  it('carries a main-authored refusal across as its code and copy, keeping the cause in the log', async () => {
    handle('settings:get', async () => {
      throw new UserFacingError('refused', 'Finish or stop the downloads first.', {
        cause: new Error('/private/tmp/HOSTILE-SENTINEL'),
      })
    })

    const reply = await registered()({}, undefined)
    expect(reply).toEqual({ ok: false, failure: { code: 'refused', userMessage: 'Finish or stop the downloads first.' } })
    expect(JSON.stringify(reply)).not.toContain('HOSTILE-SENTINEL')
    expect(JSON.stringify(mocks.logWarn.mock.calls)).toContain('HOSTILE-SENTINEL')

    let thrown: unknown
    try { unwrapIpcReply('settings:get', reply) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(IpcCallError)
    expect(thrown).toMatchObject({ code: 'refused', userMessage: 'Finish or stop the downloads first.' })
  })

  it('wraps a successful result as its value', async () => {
    handle('settings:hasApiKey', async () => true)
    const reply = await registered()({}, undefined)
    expect(unwrapIpcReply('settings:hasApiKey', reply)).toBe(true)
  })

  it('replies internal for a request that fails its schema', async () => {
    handle('downloads:add', async () => [])
    const reply = await registered()({}, { url: 42 })
    expect(reply).toEqual({ ok: false, failure: { code: 'internal', userMessage: null } })
    expect(mocks.logError).toHaveBeenCalledWith('ipc request rejected', expect.anything())
  })
})
