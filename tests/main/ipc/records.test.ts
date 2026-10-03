import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcReply } from '@shared/ipc-reply'

const handlers = new Map<string, (req: unknown) => Promise<IpcReply<unknown>>>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<IpcReply<unknown>>) => {
      handlers.set(channel, (req) => fn({}, req))
    },
  },
}))

const readRecords = vi.hoisted(() => vi.fn())
const openRecordsWindow = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@main/io/records-read', () => ({ readRecords }))
vi.mock('@main/records-window', () => ({ openRecordsWindow }))
vi.mock('@main/io/records', () => ({ currentSession: () => '2026-10-04T10:00:00.000Z' }))
vi.mock('@main/store/session', () => ({
  getTapes: () => [{ id: 't1', title: 'A tape' }, { id: 't3', title: null }],
}))
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log }))

const { registerRecordsHandlers } = await import('@main/ipc/records')

const invoke = (channel: string, req?: unknown) => handlers.get(channel)!(req)
const query = { session: null, kind: null, level: null, tapeId: null, search: '', after: null }

beforeEach(() => {
  handlers.clear()
  readRecords.mockReset()
  openRecordsWindow.mockClear()
  for (const write of Object.values(log)) write.mockClear()
  registerRecordsHandlers()
})

describe('records IPC', () => {
  it('opens the Records window', async () => {
    expect(await invoke('records:open')).toEqual({ ok: true, value: undefined })
    expect(openRecordsWindow).toHaveBeenCalledOnce()
  })

  it('reads a page and a record on the reader thread', async () => {
    readRecords.mockResolvedValueOnce({ records: [], more: false })
    expect(await invoke('records:page', { ...query, level: 'attention' })).toEqual({
      ok: true,
      value: { records: [], more: false },
    })
    expect(readRecords).toHaveBeenLastCalledWith({ op: 'page', query: { ...query, level: 'attention' } })

    readRecords.mockResolvedValueOnce(null)
    await invoke('records:detail', { kind: 'ytdlp-run', id: 4 })
    expect(readRecords).toHaveBeenLastCalledWith({ op: 'detail', kind: 'ytdlp-run', id: 4 })
  })

  it('names each tape still in the library and marks this launch', async () => {
    readRecords.mockResolvedValueOnce({ sessions: ['s2', 's1'], tapeIds: ['t1', 't2', 't3'] })
    expect(await invoke('records:sources')).toEqual({
      ok: true,
      value: {
        currentSession: '2026-10-04T10:00:00.000Z',
        sessions: ['s2', 's1'],
        tapes: [
          { tapeId: 't1', name: 'A tape' },
          { tapeId: 't2', name: null },
          { tapeId: 't3', name: null },
        ],
      },
    })
  })

  // A logged read would be a stored record that signals the next live read, so
  // an open window would read forever.
  it('writes no record for a read that succeeds', async () => {
    readRecords.mockResolvedValueOnce({ records: [], more: false })
    readRecords.mockResolvedValueOnce(null)
    readRecords.mockResolvedValueOnce({ sessions: [], tapeIds: [] })
    await invoke('records:page', query)
    await invoke('records:detail', { kind: 'log', id: 1 })
    await invoke('records:sources')
    for (const write of Object.values(log)) expect(write).not.toHaveBeenCalled()
  })

  it('refuses a query it does not recognise before reading anything', async () => {
    const reply = await invoke('records:page', { ...query, kind: 'everything' })
    expect(reply).toEqual({ ok: false, failure: { code: 'internal', userMessage: null } })
    expect(readRecords).not.toHaveBeenCalled()
  })

  it('crosses a failed read without its raw text', async () => {
    readRecords.mockRejectedValueOnce(new Error('SQLITE_BUSY /Users/someone/.tapebox/records.sqlite3'))
    expect(await invoke('records:page', query)).toEqual({ ok: false, failure: { code: 'internal', userMessage: null } })
  })
})
