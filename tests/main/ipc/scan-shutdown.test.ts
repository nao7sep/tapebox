import { afterEach, expect, it, vi } from 'vitest'
import type { ScanHandle, ScanOutcome } from '@main/services/ytdlp-scan'

const state = vi.hoisted(() => ({ handlers: new Map<string, (request: { url?: string; sessionId?: string }) => Promise<unknown>>(), start: vi.fn() }))
vi.mock('@main/ipc/handle', () => ({ handle: (channel: string, handler: (request: { url?: string; sessionId?: string }) => Promise<unknown>) => state.handlers.set(channel, handler) }))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))
vi.mock('@main/services/ytdlp-scan', () => ({ startScan: state.start }))
vi.mock('@main/store/session', () => ({ getTapes: () => [] }))
vi.mock('@main/io/logger', () => ({ log: { warn: vi.fn() } }))

let scans: typeof import('@main/ipc/scan')
const releases: Array<() => void> = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await scans?.cancelAllScans()
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
  else await state.handlers.get('scan:cancel')!({ sessionId: oldId })
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
