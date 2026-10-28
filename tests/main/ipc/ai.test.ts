vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { until } from '../../helpers/until'

const handlers = vi.hoisted(() => new Map<string, (req: unknown) => Promise<unknown>>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
      handlers.set(channel, async (req: unknown) => unwrapIpcReply(channel, (await fn({}, req)) as IpcReply<unknown>))
    },
  },
}))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
const source = vi.hoisted(() => ({ sidecarFilename: null as string | null, read: vi.fn() }))
vi.mock('@main/store/session', () => ({
  getTape: (id: string) => ({ id, title: 'A Title', uploader: 'Someone', sidecarFilename: source.sidecarFilename }),
}))
vi.mock('@main/store/config', () => ({ getLibraryDir: () => '/library' }))
vi.mock('@main/core/sidecar', () => ({ readSidecarFile: source.read }))

const seenSignals = vi.hoisted(() => [] as AbortSignal[])
vi.mock('@main/services/ai-client', () => ({
  // A provider that never answers: only an abort ends the request.
  generateSlug: (_opts: unknown, signal: AbortSignal) => {
    seenSignals.push(signal)
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Request was aborted.')), { once: true })
    })
  },
}))

const { registerAiHandlers } = await import('@main/ipc/ai')
registerAiHandlers()

beforeEach(() => { source.sidecarFilename = null; source.read.mockReset(); seenSignals.length = 0 })

describe('AI name suggestion', () => {
  it.each(['EACCES', 'EIO', 'invalid JSON', 'newer format'])('sends no request when a selected description fails: %s', async (failure) => {
    source.sidecarFilename = 't1.json'
    source.read.mockRejectedValue(new Error(failure))
    await expect(handlers.get('ai:generateSlug')!({ tapeId: 't1', requestId: 'failed-input', include: { title: true, uploader: false, description: true } })).rejects.toThrow()
    expect(source.read).toHaveBeenCalledWith('/library/t1.json')
    expect(seenSignals).toHaveLength(0)
  })

  it('keeps a genuinely absent optional description valid', async () => {
    source.sidecarFilename = 't1.json'
    source.read.mockResolvedValue({ title: 'No description' })
    const request = handlers.get('ai:generateSlug')!({ tapeId: 't1', requestId: 'empty-description', include: { title: true, uploader: false, description: true } })
    await until(() => expect(seenSignals).toHaveLength(1))
    await handlers.get('ai:cancelSlug')!({ requestId: 'empty-description' })
    await expect(request).rejects.toThrow()
  })

  it('stops a pending request when the renderer cancels it by id', async () => {
    const include = { title: true, uploader: false, description: false }
    const first = handlers.get('ai:generateSlug')!({ tapeId: 't1', include, requestId: 'r1' })
    const other = handlers.get('ai:generateSlug')!({ tapeId: 't1', include, requestId: 'r2' })
    await until(() => expect(seenSignals).toHaveLength(2))

    await handlers.get('ai:cancelSlug')!({ requestId: 'r1' })

    await expect(first).rejects.toThrow()
    expect(seenSignals[0]!.aborted).toBe(true)
    expect(seenSignals[1]!.aborted).toBe(false)

    await handlers.get('ai:cancelSlug')!({ requestId: 'r2' })
    await expect(other).rejects.toThrow()
  })
})
