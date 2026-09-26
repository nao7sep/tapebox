import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { describe, expect, it, vi } from 'vitest'
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
  getTapes: () => tapes,
  getTape: (id: string) => tapes.find((t) => t.id === id),
  upsertTape: (tape: Tape) => { tapes.push(tape) },
}))
vi.mock('@main/store/config', () => ({
  getLibraryDir: () => '/library',
  getSettings: () => ({ autoStartDownloads: true }),
}))
let stems = 0
vi.mock('@main/core/stem', () => ({
  // Checking the library for a free stem takes a filesystem round trip.
  reserveStem: async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return `stem${++stems}`
  },
}))
vi.mock('@main/queue/manager', () => ({ tick: vi.fn(), cancel: vi.fn() }))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))

const { registerDownloadHandlers } = await import('@main/ipc/downloads')
registerDownloadHandlers()

describe('adding URLs', () => {
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
