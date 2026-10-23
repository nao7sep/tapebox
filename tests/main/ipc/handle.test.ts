import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { trustApplicationDocument } from '@main/ipc/trust'
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
import { message } from '@shared/i18n/translate'

function trustedEvent(): IpcMainInvokeEvent {
  const senderFrame = { url: 'file:///app/index.html' }
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: senderFrame }) as unknown as WebContents
  trustApplicationDocument(sender, senderFrame.url)
  return { sender, senderFrame } as IpcMainInvokeEvent
}

type Callback = (_event: unknown, request: unknown) => Promise<IpcReply<unknown>>

function registered(): Callback {
  return mocks.handle.mock.calls.at(-1)![1] as Callback
}

describe('IPC failure boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refuses an unregistered document before invoking privileged code', async () => {
    const handler = vi.fn(async () => 'set' as const)
    handle('settings:apiKeyState', handler)
    const event = trustedEvent()
    Object.assign(event.senderFrame!, { url: 'https://foreign.example/' })
    expect(await registered()(event, undefined)).toMatchObject({ ok: false })
    expect(handler).not.toHaveBeenCalled()
  })

  it('logs hostile diagnostics but replies with no copy of its own', async () => {
    const hostile = new Error('EACCES Error invoking remote method IPC /private/tmp/HOSTILE-SENTINEL', {
      cause: new TypeError('root cause'),
    })
    handle('settings:get', async () => { throw hostile })

    const reply = await registered()(trustedEvent(), undefined)
    expect(reply).toEqual({ ok: false, failure: { code: 'internal', userMessage: null } })
    expect(JSON.stringify(reply)).not.toContain('HOSTILE-SENTINEL')
    expect(() => unwrapIpcReply('settings:get', reply)).toThrow('The operation could not be completed.')

    expect(JSON.stringify(mocks.logError.mock.calls)).toContain('HOSTILE-SENTINEL')
    expect(JSON.stringify(mocks.logError.mock.calls)).toContain('root cause')
  })

  it('carries a main-authored refusal across as its code and copy, keeping the cause in the log', async () => {
    handle('settings:get', async () => {
      throw new UserFacingError('refused', message('errors.libraryMoveBlocked'), {
        cause: new Error('/private/tmp/HOSTILE-SENTINEL'),
      })
    })

    const reply = await registered()(trustedEvent(), undefined)
    expect(reply).toEqual({ ok: false, failure: { code: 'refused', userMessage: { key: 'errors.libraryMoveBlocked' } } })
    expect(JSON.stringify(reply)).not.toContain('HOSTILE-SENTINEL')
    expect(JSON.stringify(mocks.logWarn.mock.calls)).toContain('HOSTILE-SENTINEL')

    let thrown: unknown
    try { unwrapIpcReply('settings:get', reply) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(IpcCallError)
    expect(thrown).toMatchObject({ code: 'refused', userMessage: { key: 'errors.libraryMoveBlocked' } })
  })

  it('wraps a successful result as its value', async () => {
    handle('settings:apiKeyState', async () => 'set' as const)
    const reply = await registered()(trustedEvent(), undefined)
    expect(unwrapIpcReply('settings:apiKeyState', reply)).toBe('set')
  })

  it('replies internal for a request that fails its schema', async () => {
    handle('downloads:add', async () => [])
    const reply = await registered()(trustedEvent(), { url: 42 })
    expect(reply).toEqual({ ok: false, failure: { code: 'internal', userMessage: null } })
    expect(mocks.logError).toHaveBeenCalledWith('ipc request rejected', expect.anything())
  })
})
