import { afterEach, expect, it, vi } from 'vitest'
import type { ScanHandle, ScanOutcome } from '@main/services/ytdlp-scan'

const state = vi.hoisted(() => ({ handlers: new Map<string, (request: { url?: string; sessionId?: string; search?: string; start?: number; selected?: boolean }) => Promise<unknown>>(), start: vi.fn() }))
vi.mock('@main/ipc/handle', () => ({ handle: (channel: string, handler: (request: { url?: string; sessionId?: string; search?: string; start?: number; selected?: boolean }) => Promise<unknown>) => state.handlers.set(channel, handler) }))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))
vi.mock('@main/services/ytdlp-scan', () => ({ startScan: state.start }))
vi.mock('@main/store/session', () => ({ getTapes: () => [], sourceOwner: () => null }))
vi.mock('@main/ipc/downloads', () => ({ addScannedUrls: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log: { warn: vi.fn() } }))

let scans: typeof import('@main/ipc/scan')
const releases: Array<() => void> = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await scans?.cancelAllScans()
  await scans?.closeScanStores()
  vi.restoreAllMocks()
})

it.each(['quit', 'cancel'] as const)('keeps a %s-requested scan owned across reopening and a second quit', async (first) => {
  vi.resetModules()
  state.handlers.clear()
  state.start.mockReset()
  scans = await import('@main/ipc/scan')
  scans.registerScanHandlers()
  function held(): ScanHandle {
    let release!: () => void
    const complete = new Promise<ScanOutcome>((resolve) => { release = () => resolve({ kind: 'stopped', totalCount: 0 }) })
    releases.push(release)
    return { cancel: vi.fn(), complete }
  }
  const old = held()
  state.start.mockReturnValueOnce(old)
  const { sessionId: oldId } = await state.handlers.get('scan:start')!({ url: 'https://example.test/old' }) as { sessionId: string }
  let firstDrain: Promise<void> | undefined
  if (first === 'quit') firstDrain = scans.cancelAllScans()
  else firstDrain = state.handlers.get('scan:cancel')!({ sessionId: oldId }) as Promise<void>
  expect(old.cancel).toHaveBeenCalledWith(first)
  scans.resumeScans()
  const fresh = held()
  state.start.mockReturnValueOnce(fresh)
  await state.handlers.get('scan:start')!({ url: 'https://example.test/new' })
  const secondDrain = scans.cancelAllScans()
  let finished = false
  void secondDrain.then(() => { finished = true })
  releases[1]!()
  await Promise.resolve()
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(old.cancel).toHaveBeenLastCalledWith('quit')
  releases[0]!()
  await secondDrain
  await firstDrain
  expect(finished).toBe(true)
})

it('retains stopped results through a cancelled quit and disposes only after an add settles', async () => {
  vi.resetModules()
  state.handlers.clear()
  scans = await import('@main/ipc/scan')
  scans.registerScanHandlers()
  let entry!: (entry: import('@main/services/ytdlp-scan').ScannedEntry) => Promise<void>
  let settle!: () => void
  const complete = new Promise<ScanOutcome>(resolve => { settle = () => resolve({ kind: 'stopped', totalCount: 1 }) })
  state.start.mockImplementation((_url, _id, callback) => {
    entry = callback
    return { cancel: settle, complete }
  })
  const { sessionId } = await state.handlers.get('scan:start')!({ url: 'https://example.test/list' }) as { sessionId: string }
  await entry({ id: '1', url: 'https://example.test/1', title: 'one', extractor: null, duration: null, uploadDate: null, thumbnailUrl: null })
  await scans.cancelAllScans()
  scans.resumeScans()
  expect(await state.handlers.get('scan:page')!({ sessionId, search: '', start: 0 })).toMatchObject({ total: 1, selected: 1, status: 'stopped' })
  const { addScannedUrls } = await import('@main/ipc/downloads')
  let finishAdd!: () => void
  const held = new Promise<void>(resolve => { finishAdd = resolve })
  const consumed: string[] = []
  vi.mocked(addScannedUrls).mockImplementation(async urls => {
    for await (const url of urls) consumed.push(url)
    await held
    return consumed.length
  })
  const adding = state.handlers.get('scan:add')!({ sessionId })
  await vi.waitFor(() => expect(consumed).toEqual(['https://example.test/1']))
  await expect(state.handlers.get('scan:select')!({ sessionId, selected: false })).rejects.toThrow('being added')
  let released = false
  const releasing = state.handlers.get('scan:release')!({ sessionId }).then(() => { released = true })
  await Promise.resolve()
  expect(released).toBe(false)
  finishAdd()
  await expect(adding).resolves.toEqual({ added: 1 })
  await releasing
  await expect(state.handlers.get('scan:page')!({ sessionId, search: '', start: 0 })).rejects.toThrow('no longer available')
})
