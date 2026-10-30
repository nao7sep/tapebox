import { collectionSourceIndex } from '@shared/source-identity'
import type { SourceRef } from '@shared/source-identity'
vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'

const handlers = vi.hoisted(() => new Map<string, (req: unknown) => Promise<unknown>>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
      handlers.set(channel, async (req: unknown) => unwrapIpcReply(channel, (await fn({}, req)) as IpcReply<unknown>))
    },
  },
}))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
const tapes = vi.hoisted(() => [] as Tape[])
vi.mock('@main/store/session', () => ({
  sourceOwner: (ref: SourceRef, exceptId?: string) => collectionSourceIndex(tapes, exceptId).find(ref),
  getTapes: () => tapes,
  getTape: (id: string) => tapes.find((t) => t.id === id),
  upsertTape: (tape: Tape) => {
    const index = tapes.findIndex((t) => t.id === tape.id)
    if (index >= 0) tapes[index] = tape
    else tapes.push(tape)
  },
}))
vi.mock('@main/store/config', () => ({
  getCollectionDir: () => '/library',
  getSettings: () => ({ autoStartDownloads: true }),
}))
const stat = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(), stat }))
beforeEach(() => {
  tapes.length = 0
  vi.clearAllMocks()
  stat.mockReset().mockImplementation(async () => {
    await Promise.resolve()
    throw Object.assign(new Error('not found'), { code: 'ENOENT' })
  })
})
vi.mock('@main/queue/manager', () => ({ tick: vi.fn(), cancel: vi.fn() }))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))

const { registerDownloadHandlers } = await import('@main/ipc/downloads')
registerDownloadHandlers()

describe('adding URLs', () => {
  it.each(['EACCES', 'EIO'])('does not add or announce a tape after a stem lookup fails with %s', async (code) => {
    const { emit } = await import('@main/ipc/events')
    const { tick } = await import('@main/queue/manager')
    stat.mockRejectedValue(Object.assign(new Error('library unavailable'), { code }))
    await expect(handlers.get('downloads:add')!({ url: 'https://example.test/watch' })).rejects.toMatchObject({ code: 'internal' })
    await expect(handlers.get('downloads:addBulk')!({ urls: ['https://example.test/watch'] })).rejects.toMatchObject({ code: 'internal' })
    expect(tapes).toEqual([])
    expect(emit).not.toHaveBeenCalled()
    expect(tick).not.toHaveBeenCalled()
  })

  it('tries another id when a folder already holds the first one', async () => {
    stat.mockResolvedValueOnce({})
    await handlers.get('downloads:add')!({ url: 'https://example.test/watch' })
    // The first id's Inbox folder is taken; the second is free in the Inbox and on the Shelf.
    expect(stat).toHaveBeenCalledTimes(3)
    expect(tapes).toHaveLength(1)
  })

  it('creates one tape when the same URL is added twice at once', async () => {
    tapes.length = 0
    const add = handlers.get('downloads:add')!
    const results = await Promise.allSettled([
      add({ url: 'https://example.test/watch?v=1' }),
      add({ url: 'https://example.test/watch?v=1' }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(tapes).toHaveLength(1)
  })

  it('creates one tape per URL when overlapping bulk adds share URLs', async () => {
    tapes.length = 0
    const addBulk = handlers.get('downloads:addBulk')!
    await Promise.all([
      addBulk({ urls: ['https://example.test/a', 'https://example.test/b'] }),
      addBulk({ urls: ['https://example.test/b', 'https://example.test/c', 'https://example.test/c'] }),
    ])
    expect(tapes.map((t) => t.sourceUrl).sort()).toEqual([
      'https://example.test/a', 'https://example.test/b', 'https://example.test/c',
    ])
  })
})

describe('Inbox order of added tapes', () => {
  it('gives a single add the time it was added and a batch one time with its pasted positions', async () => {
    tapes.length = 0
    const [single] = (await handlers.get('downloads:add')!({ url: 'https://example.test/one' })) as Tape[]
    const batch = (await handlers.get('downloads:addBulk')!({
      urls: ['https://example.test/first', 'https://example.test/second', 'https://example.test/third'],
    })) as Tape[]

    expect(single).toMatchObject({ addedIndex: 0, shelved: false, boxId: null })
    expect(batch.map((tape) => tape.addedIndex)).toEqual([0, 1, 2])
    expect(new Set(batch.map((tape) => tape.addedAtUtc)).size).toBe(1)
    expect(batch[0]!.addedAtUtc >= single!.addedAtUtc).toBe(true)
    const { compareInbox } = await import('@shared/order')
    // The batch tops the Inbox in its pasted order, first URL topmost.
    expect([...tapes].sort(compareInbox).slice(0, 3).map((tape) => tape.sourceUrl)).toEqual([
      'https://example.test/first', 'https://example.test/second', 'https://example.test/third',
    ])
  })
})

describe('retrying a download', () => {
  async function added(): Promise<Tape> {
    tapes.length = 0
    const [tape] = (await handlers.get('downloads:add')!({ url: 'https://example.test/watch?v=retry' })) as Tape[]
    return tape!
  }

  it('re-queues a failed download that has no files yet', async () => {
    const tape = await added()
    tapes[0] = { ...tape, state: 'failed', failureCode: 'download', lastError: 'x' }
    await handlers.get('downloads:retry')!({ tapeId: tape.id })
    expect(tapes[0]).toMatchObject({ state: 'queued', failureCode: null, lastError: null })
  })

  it('never sends a finished tape back through a download', async () => {
    const tape = await added()
    const downloaded = { ...tape, state: 'downloaded' as const, filename: 'f.mp4', sidecarFilename: 'f.json' }
    tapes[0] = downloaded
    await handlers.get('downloads:retry')!({ tapeId: tape.id })
    expect(tapes[0]).toEqual(downloaded)
  })

})
