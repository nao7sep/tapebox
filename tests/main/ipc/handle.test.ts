import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('@main/io/logger', () => ({ log: { error: mocks.logError } }))

import { handle } from '@main/ipc/handle'

describe('IPC failure boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('logs hostile diagnostics but rejects with stable authored copy', async () => {
    const hostile = new Error('EACCES Error invoking remote method IPC /private/tmp/HOSTILE-SENTINEL', {
      cause: new TypeError('root cause'),
    })
    handle('settings:get', async () => { throw hostile })

    const callback = mocks.handle.mock.calls[0]![1] as (_event: unknown, request: unknown) => Promise<unknown>
    await expect(callback({}, undefined)).rejects.toThrow('The operation could not be completed.')
    await expect(callback({}, undefined)).rejects.not.toThrow('HOSTILE-SENTINEL')

    expect(JSON.stringify(mocks.logError.mock.calls)).toContain('HOSTILE-SENTINEL')
    expect(JSON.stringify(mocks.logError.mock.calls)).toContain('root cause')
  })
})
