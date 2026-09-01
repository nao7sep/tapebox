// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BinaryStatus } from '@shared/ipc-contract'

const { ipcInvoke } = vi.hoisted(() => ({ ipcInvoke: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke }))

import {
  requiredBinariesUsable,
  binariesNeedAttention,
  derivedOf,
  summarizeBinaries,
  useBinariesStore,
} from '@renderer/store/binaries'

// An up-to-date tool: the quiet baseline each case deviates from.
function status(over: Partial<BinaryStatus> = {}): BinaryStatus {
  return {
    name: 'yt-dlp',
    present: true,
    installedVersion: '1.0.0',
    latestKnownVersion: '1.0.0',
    lastCheckedAtUtc: '2026-06-29T00:00:00.000Z',
    ...over,
  }
}

const absent = status({ present: false })
const updateAvailable = status({ latestKnownVersion: '2.0.0' })
const unchecked = status({ latestKnownVersion: null, lastCheckedAtUtc: null })
// Present, and a check DID succeed — but the binary would not report its own
// version, so there is nothing to compare it against.
const unreadable = status({ installedVersion: null, latestKnownVersion: '2.0.0' })

beforeEach(() => {
  ipcInvoke.mockReset()
  useBinariesStore.setState({
    statuses: [],
    progress: {},
    active: {},
    errors: {},
    terminalOutcomes: {},
    statusRevisions: {},
    modalOpen: false,
    checking: false,
    checkCancelling: false,
    checkError: null,
    checkFailures: null,
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('derivedOf', () => {
  it('maps a wire status to its derived four-state via the shared rule', () => {
    expect(derivedOf(status())).toEqual({ state: 'up-to-date', role: 'none' })
    expect(derivedOf(absent).state).toBe('not-installed')
    expect(derivedOf(updateAvailable).state).toBe('update-available')
    expect(derivedOf(unchecked).state).toBe('installed-unchecked')
    expect(derivedOf(unreadable).state).toBe('installed-unchecked')
  })
})

describe('summarizeBinaries — worst-role roll-up', () => {
  it('all up to date → quiet "Tools ready"', () => {
    expect(summarizeBinaries([status(), status()])).toEqual({ role: 'none', text: 'Tools ready', actionable: false })
  })

  it('not-installed → warning, pluralized, actionable', () => {
    expect(summarizeBinaries([absent, status()])).toMatchObject({ role: 'warning', text: '1 tool isn’t installed', actionable: true })
    expect(summarizeBinaries([absent, status({ name: 'ffmpeg', present: false })]).text).toBe('2 tools aren’t installed')
  })

  it('update-available (no absent) → warning "updates available"', () => {
    expect(summarizeBinaries([updateAvailable, status()])).toMatchObject({ role: 'warning', text: '1 update available', actionable: true })
  })

  it('not-installed outranks update-available (reports the missing count)', () => {
    const s = summarizeBinaries([absent, updateAvailable])
    expect(s.role).toBe('warning')
    expect(s.text).toBe('1 tool isn’t installed')
  })

  it('installed-unchecked → informational "Updates not checked" (benign, not actionable)', () => {
    expect(summarizeBinaries([unchecked, status()])).toEqual({ role: 'info', text: 'Updates not checked', actionable: false })
  })

  it('treats missing optional Deno as informational and actionable', () => {
    const deno = status({ name: 'deno', present: false, installedVersion: null })
    expect(summarizeBinaries([status(), status({ name: 'ffmpeg' }), deno])).toEqual({
      role: 'info',
      text: 'Optional tool isn’t installed',
      actionable: true,
    })
  })

  // Both are informational, but only one asks something of the user: a tool whose
  // own version could not be read needs re-acquiring, and the set-wide Check can
  // never clear it, so the roll-up says so and opens the modal.
  it('a tool whose version could not be read says so, and is actionable', () => {
    expect(summarizeBinaries([unreadable, status()])).toEqual({
      role: 'info',
      text: '1 tool couldn’t be read',
      actionable: true,
    })
    expect(summarizeBinaries([unreadable, status({ name: 'deno', installedVersion: null })]).text).toBe(
      '2 tools couldn’t be read',
    )
  })

  it('an unreadable tool never outranks a real warning', () => {
    expect(summarizeBinaries([unreadable, absent]).text).toBe('1 tool isn’t installed')
  })
})

describe('binariesNeedAttention — startup auto-open trigger', () => {
  it('true only for a not-installed tool (the one blocking condition)', () => {
    expect(binariesNeedAttention([absent])).toBe(true)
  })

  it('false for benign states (up-to-date / update-available / unchecked / unreadable)', () => {
    expect(binariesNeedAttention([status(), updateAvailable, unchecked, unreadable])).toBe(false)
  })

  it('does not auto-open for missing optional Deno', () => {
    expect(binariesNeedAttention([status({ name: 'deno', present: false })])).toBe(false)
  })
})

describe('requiredBinariesUsable', () => {
  it('true when every tool is present, whatever its version reads as', () => {
    expect(requiredBinariesUsable([status(), status({ name: 'ffmpeg', installedVersion: null })])).toBe(true)
  })

  it('false when any tool is not installed', () => {
    expect(requiredBinariesUsable([status(), absent])).toBe(false)
  })

  it('false for an empty set (status not yet known)', () => {
    expect(requiredBinariesUsable([])).toBe(false)
  })

  it('does not block the app when optional Deno is absent', () => {
    expect(requiredBinariesUsable([status(), status({ name: 'ffmpeg' }), status({ name: 'deno', present: false })])).toBe(true)
  })
})

describe('application-owned acquisition lifecycle', () => {
  it('applies authoritative readiness before making the row idle', async () => {
    useBinariesStore.setState({ statuses: [absent] })
    ipcInvoke.mockImplementationOnce((_channel, request: { operationId: string }) =>
      Promise.resolve({
        outcome: 'installed',
        operationId: request.operationId,
        status: status(),
      }),
    )

    await useBinariesStore.getState().install('yt-dlp')

    const state = useBinariesStore.getState()
    expect(state.active['yt-dlp']).toBeUndefined()
    expect(state.statuses[0]).toEqual(status())
    expect(derivedOf(state.statuses[0]!).state).toBe('up-to-date')
  })

  it('retains a failed terminal result and refreshed partial facts across modal replacement', async () => {
    useBinariesStore.setState({ statuses: [absent], modalOpen: true })
    const terminal = deferred<{
      outcome: 'failed'
      operationId: string
      status: BinaryStatus
      error: string
    }>()
    ipcInvoke.mockImplementationOnce((_channel, request: { operationId: string }) => {
      terminal.promise.then((result) => expect(result.operationId).toBe(request.operationId))
      return terminal.promise
    })

    const install = useBinariesStore.getState().install('yt-dlp')
    const operationId = useBinariesStore.getState().active['yt-dlp']!.operationId
    useBinariesStore.getState().closeModal()
    terminal.resolve({
      outcome: 'failed',
      operationId,
      status: status({ installedVersion: null, latestKnownVersion: '2.0.0' }),
      error: 'sidecar write failed',
    })
    await install
    useBinariesStore.getState().openModal()

    expect(useBinariesStore.getState()).toMatchObject({
      modalOpen: true,
      active: {},
      errors: { 'yt-dlp': 'sidecar write failed' },
    })
    expect(useBinariesStore.getState().statuses[0]).toMatchObject({
      present: true,
      installedVersion: null,
    })
  })

  it('ignores progress from a different or already-settled attempt', async () => {
    useBinariesStore.setState({ statuses: [absent] })
    const terminal = deferred<{
      outcome: 'cancelled'
      operationId: string
      status: BinaryStatus
    }>()
    ipcInvoke.mockReturnValueOnce(terminal.promise)

    const install = useBinariesStore.getState().install('yt-dlp')
    const operationId = useBinariesStore.getState().active['yt-dlp']!.operationId
    useBinariesStore.getState().setProgress('yt-dlp', 'older-attempt', 90, 'install')
    expect(useBinariesStore.getState().progress['yt-dlp']).toBeUndefined()

    useBinariesStore.getState().setProgress('yt-dlp', operationId, 25, 'download')
    expect(useBinariesStore.getState().progress['yt-dlp']).toEqual({ percent: 25, phase: 'download' })
    terminal.resolve({ outcome: 'cancelled', operationId, status: absent })
    await install
    useBinariesStore.getState().setProgress('yt-dlp', operationId, 100, 'install')
    expect(useBinariesStore.getState().progress['yt-dlp']).toBeUndefined()
    expect(useBinariesStore.getState().terminalOutcomes['yt-dlp']).toBe('cancelled')
  })

  it('retains cancellation across modal replacement until retry supersedes it', async () => {
    useBinariesStore.setState({ statuses: [absent], modalOpen: true })
    ipcInvoke.mockImplementationOnce((_channel, request: { operationId: string }) =>
      Promise.resolve({ outcome: 'cancelled', operationId: request.operationId, status: absent }),
    )

    await useBinariesStore.getState().install('yt-dlp')
    useBinariesStore.getState().closeModal()
    useBinariesStore.getState().openModal()

    expect(useBinariesStore.getState().terminalOutcomes['yt-dlp']).toBe('cancelled')

    const retry = deferred<{
      outcome: 'installed'
      operationId: string
      status: BinaryStatus
    }>()
    ipcInvoke.mockReturnValueOnce(retry.promise)
    const installing = useBinariesStore.getState().install('yt-dlp')
    expect(useBinariesStore.getState().terminalOutcomes['yt-dlp']).toBeUndefined()
    const operationId = useBinariesStore.getState().active['yt-dlp']!.operationId
    retry.resolve({ outcome: 'installed', operationId, status: status() })
    await installing
  })

  it('keeps independent rows active and settles them in either order', async () => {
    const ffmpegAbsent = status({ name: 'ffmpeg', present: false, installedVersion: null })
    useBinariesStore.setState({ statuses: [absent, ffmpegAbsent] })
    const terminals = new Map<string, ReturnType<typeof deferred>>()
    ipcInvoke.mockImplementation((_channel, request: { name: string; operationId: string }) => {
      const terminal = deferred()
      terminals.set(request.name, terminal)
      return terminal.promise
    })

    const ytInstall = useBinariesStore.getState().install('yt-dlp')
    const ffmpegInstall = useBinariesStore.getState().install('ffmpeg')
    const ytOperationId = useBinariesStore.getState().active['yt-dlp']!.operationId
    const ffmpegOperationId = useBinariesStore.getState().active.ffmpeg!.operationId
    terminals.get('ffmpeg')!.resolve({
      outcome: 'installed',
      operationId: ffmpegOperationId,
      status: status({ name: 'ffmpeg' }),
    })
    await ffmpegInstall
    expect(useBinariesStore.getState().active['yt-dlp']).toBeDefined()
    terminals.get('yt-dlp')!.resolve({
      outcome: 'installed',
      operationId: ytOperationId,
      status: status(),
    })
    await ytInstall

    expect(useBinariesStore.getState().active).toEqual({})
    expect(useBinariesStore.getState().statuses.every((entry) => entry.present)).toBe(true)
  })

  it('does not let a concurrent check snapshot overwrite a newer install result', async () => {
    useBinariesStore.setState({ statuses: [absent] })
    const check = deferred<{
      outcome: 'completed'
      statuses: BinaryStatus[]
      failures: []
    }>()
    ipcInvoke.mockImplementation((channel, request: { operationId?: string } | undefined) => {
      if (channel === 'binaries:checkUpdates') return check.promise
      return Promise.resolve({
        outcome: 'installed',
        operationId: request!.operationId,
        status: status(),
      })
    })

    const checking = useBinariesStore.getState().checkUpdates()
    await useBinariesStore.getState().install('yt-dlp')
    check.resolve({
      outcome: 'completed',
      statuses: [status({
        present: false,
        installedVersion: null,
        latestKnownVersion: '2.0.0',
        lastCheckedAtUtc: '2026-09-01T00:00:00.000Z',
      })],
      failures: [],
    })
    await checking

    expect(useBinariesStore.getState().statuses[0]).toEqual(status({
      latestKnownVersion: '2.0.0',
      lastCheckedAtUtc: '2026-09-01T00:00:00.000Z',
    }))
  })
})
