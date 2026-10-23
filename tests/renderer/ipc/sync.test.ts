import { runTapeAction } from '@renderer/lib/runTapeAction'
import { useBoxActionResultsStore } from '@renderer/store/boxActionResults'
import { useTapeActionResultsStore } from '@renderer/store/tapeActionResults'
import { useSelectionStore } from '@renderer/store/selection'
import { useArchiveStore } from '@renderer/store/archive'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultLayout } from '@shared/layout'
import { defaultSettings } from '@shared/settings'
import type { Tape } from '@shared/domain'

const { ipcInvoke, ipcOn } = vi.hoisted(() => ({ ipcInvoke: vi.fn(), ipcOn: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke, ipcOn }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn() } }))

import { LIBRARY_SAVE_FAILED_MESSAGE, applyInitialSyncState, pullInitialSyncState, startIpcSync } from '@renderer/ipc/sync'
import { useToastStore } from '@renderer/store/toast'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useBinariesStore } from '@renderer/store/binaries'
import { useRuntimeStore } from '@renderer/store/runtime'
import { mediaFileUrl, useMediaStore } from '@renderer/store/media'
import { useLayoutStore } from '@renderer/store/layout'
import { useSettingsStore } from '@renderer/store/settings'
import { useOrderFailuresStore } from '@renderer/store/orderFailures'

function tape(id: string, order: number, boxId: string | null = null, archived = false): Tape {
  return {
    id, order, boxId, archivedAtUtc: archived ? '2026-10-11T00:00:00.000Z' : null,
    sourceUrl: `https://example.test/${id}`, state: 'downloaded', addedAtUtc: '2026-10-11T00:00:00.000Z',
    sourceId: null, extractor: null, title: id, uploader: null, durationSeconds: null, chapterCount: null,
    probedAtUtc: null, filename: null, sidecarFilename: null, thumbnailFilename: null,
    downloadStartedAtUtc: null, downloadedAtUtc: null, name: null, renamedAtUtc: null,
    pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
  }
}

beforeEach(() => {
  ipcInvoke.mockReset()
  ipcOn.mockReset()
  useOrderFailuresStore.setState({ inbox: null, boxes: null, archiveTapes: {}, attempts: {}, pending: {} })
  useTapesStore.setState({ tapes: [], progress: {} })
  useBoxesStore.setState({ boxes: [] })
  useBinariesStore.setState({ statuses: [] })
  useRuntimeStore.setState({ info: null })
  useMediaStore.setState({ baseUrl: null, collectionRevision: 0 })
  useLayoutStore.setState({ layout: null, appliedLayout: null, writeErrors: {} })
  useSettingsStore.setState({ settings: null, writeErrors: {}, saving: {} })
})

describe('required renderer hydration', () => {
  it('does not publish false defaults or partial snapshots when one pull rejects', async () => {
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === 'layout:get') {
        return Promise.reject(new Error('EACCES /private/tmp/TAPEBOX_HYDRATION_SENTINEL'))
      }
      const values: Record<string, unknown> = {
        'library:list': [],
        'boxes:list': [],
        'binaries:status': [],
        'app:runtimeInfo': { platform: 'darwin', arch: 'arm64', version: '1.0.0' },
        'media:endpoint': { baseUrl: 'http://127.0.0.1:1234' },
        'settings:get': defaultSettings(),
      }
      return Promise.resolve(values[channel])
    })

    await expect(pullInitialSyncState()).rejects.toThrow('TAPEBOX_HYDRATION_SENTINEL')
    expect(useMediaStore.getState().baseUrl).toBeNull()
    expect(useLayoutStore.getState().layout).toBeNull()
    expect(useSettingsStore.getState().settings).toBeNull()
    expect(useRuntimeStore.getState().info).toBeNull()
  })

  it('commits the complete snapshot together after every required pull succeeds', async () => {
    const settings = defaultSettings()
    ipcInvoke.mockImplementation((channel: string) => Promise.resolve({
      'library:list': [],
      'boxes:list': [],
      'binaries:status': [],
      'app:runtimeInfo': { platform: 'darwin', arch: 'arm64', version: '1.0.0' },
      'media:endpoint': { baseUrl: 'http://127.0.0.1:1234' },
      'layout:get': defaultLayout,
      'settings:get': settings,
    }[channel]))

    const snapshot = await pullInitialSyncState()
    applyInitialSyncState(snapshot)

    expect(useMediaStore.getState().baseUrl).toBe('http://127.0.0.1:1234')
    expect(useLayoutStore.getState().layout).toEqual(defaultLayout)
    expect(useLayoutStore.getState().appliedLayout).toEqual(defaultLayout)
    expect(useSettingsStore.getState().settings).toEqual(settings)
    expect(useRuntimeStore.getState().info?.platform).toBe('darwin')
  })
})

describe('live sync', () => {
  it('gives video and poster files distinct URLs on every Open, including returning to an earlier library', () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    ipcOn.mockImplementation((channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    })
    const sync = startIpcSync()
    useMediaStore.setState({ baseUrl: 'http://127.0.0.1:1234/token' })
    const urls = () => ['same name.mp4', 'same name.jpg'].map((name) => mediaFileUrl(useMediaStore.getState(), name))
    const before = urls()
    listeners.get('library:opened')!({ tapes: [], boxes: [] })
    const other = urls()
    expect(other[0]).not.toBe(before[0])
    expect(other[1]).not.toBe(before[1])
    listeners.get('library:opened')!({ tapes: [], boxes: [] })
    expect(urls()[0]).not.toBe(other[0])
    expect(urls()[0]).not.toBe(before[0])
    // An ordinary update in the same collection preserves reusable byte ranges.
    const current = urls()
    listeners.get('boxes:changed')!([])
    expect(urls()).toEqual(current)
    expect(new URL(urls()[0]!).pathname).toBe('/token/same%20name.mp4')
    sync.stop()
  })

  it('replaces the collection during hydration and clears the previous collection view and pending results', async () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    ipcOn.mockImplementation((channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    })
    const old = tape('SameTapeId', 9)
    const fresh = tape('SameTapeId', 3)
    useTapesStore.setState({ tapes: [old], progress: { [old.id]: { phase: 'downloading', percent: 50 } }, stalled: { [old.id]: true } })
    useSelectionStore.getState().select(old.id)
    useArchiveStore.getState().selectBox('OldBoxId')
    useArchiveStore.getState().setQuery('old search')
    const attempt = useOrderFailuresStore.getState().beginAttempt('inbox', [old])
    useOrderFailuresStore.getState().setInbox({ key: 'app.librarySaveFailed' })
    let fail!: (reason: Error) => void
    const oldAction = runTapeAction(old.id, 'archive', 'archive failed', { key: 'app.librarySaveFailed' }, () => new Promise((_resolve, reject) => { fail = reject }))
    useBoxActionResultsStore.getState().setResult('create', { key: 'app.librarySaveFailed' })
    const sync = startIpcSync()
    const hydration = sync.beginHydration()
    const boxes = [{ id: 'FreshBoxId', name: 'Fresh', order: 0 }]
    listeners.get('library:opened')!({ tapes: [fresh], boxes })
    fail(new Error('old collection result'))
    expect(await oldAction).toBe('superseded')
    expect(useBoxActionResultsStore.getState().results).toEqual({})
    expect(useTapeActionResultsStore.getState().byTape).toEqual({})
    expect(useSelectionStore.getState().selectedId).toBeNull()
    expect(useArchiveStore.getState()).toMatchObject({ selectedBoxId: null, query: '' })
    expect(useTapesStore.getState()).toMatchObject({ tapes: [fresh], progress: {}, stalled: {} })
    expect(useOrderFailuresStore.getState()).toMatchObject({ inbox: null, pending: {} })
    expect(useOrderFailuresStore.getState().isCurrentAttempt('inbox', attempt)).toBe(false)
    const nextAttempt = useOrderFailuresStore.getState().beginAttempt('inbox', [fresh])
    expect(nextAttempt).not.toBe(attempt)
    hydration.commit({ tapes: [old], boxes: [], binaries: [], runtime: { platform: 'darwin', arch: 'arm64', version: '1' }, mediaBaseUrl: 'http://127.0.0.1', layout: defaultLayout, settings: defaultSettings() })
    expect(useTapesStore.getState().tapes).toEqual([fresh])
    expect(useBoxesStore.getState().boxes).toEqual(boxes)
    sync.stop()
  })

  it('advances pending baselines only at canonical events, retaining list independence and organization ABA', () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    ipcOn.mockImplementation((channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    })
    const sync = startIpcSync()
    const a = tape('OrderTapeA', 10)
    const b = tape('OrderTapeB', 20)
    const c = tape('OrderTapeC', 30, 'SourceBox1', true)
    const boxes = [{ id: 'SourceBox1', name: 'Source', order: 10 }]
    useTapesStore.getState().setAll([a, b, c])
    useBoxesStore.getState().setBoxes(boxes)
    const owner = useOrderFailuresStore.getState()
    const inbox = owner.beginAttempt('inbox', [a, b])
    const archive = owner.beginAttempt('archive:box:SourceBox1', [c])
    const boxAttempt = owner.beginAttempt('boxes', boxes)
    try {
      // Direct store writes are optimistic callers, never canonical confirmation.
      useTapesStore.getState().upsertMany([{ ...a, order: 1 }, { ...b, order: 0 }])
      useBoxesStore.getState().setBoxes([{ ...boxes[0]!, order: 0 }])
      expect(owner.confirmedOrder('inbox')).toEqual([{ id: a.id, order: 10 }, { id: b.id, order: 20 }])
      expect(owner.confirmedOrder('boxes')).toEqual([{ id: boxes[0]!.id, order: 10 }])

      listeners.get('tapes:updated')!({ ...a, title: 'Main metadata', order: 10 })
      listeners.get('tapes:updatedMany')!([{ ...a, boxId: 'SourceBox1', archivedAtUtc: '2026-10-11T00:00:01.000Z', order: 0 }])
      expect(owner.confirmedOrder('inbox')).toEqual([{ id: b.id, order: 20 }])
      expect(owner.confirmedOrder('archive:box:SourceBox1')).toEqual([{ id: c.id, order: 30 }, { id: a.id, order: 0 }])
      // ABA returning to the same order confirms membership again, independently
      // of the live optimistic value and without restoring another list's fields.
      listeners.get('tapes:updated')!(a)
      listeners.get('tapes:removed')!({ tapeIds: [b.id] })
      const added = tape('OrderTapeN', -1)
      listeners.get('tapes:added')!([added])
      expect(owner.confirmedOrder('inbox')).toEqual([{ id: a.id, order: 10 }, { id: added.id, order: -1 }])
      expect(owner.confirmedOrder('archive:box:SourceBox1')).toEqual([{ id: c.id, order: 30 }])
      listeners.get('boxes:changed')!([{ ...boxes[0]!, name: 'Main name', order: 7 }, { id: 'NewBox0001', name: 'Added', order: 0 }])
      expect(owner.confirmedOrder('boxes')).toEqual([{ id: boxes[0]!.id, order: 7 }, { id: 'NewBox0001', order: 0 }])
    } finally {
      owner.finishAttempt('inbox', inbox)
      owner.finishAttempt('archive:box:SourceBox1', archive)
      owner.finishAttempt('boxes', boxAttempt)
      sync.stop()
    }
    expect(useOrderFailuresStore.getState().pending).toEqual({})
  })

  it('confirms the merged hydration catalog while outstanding attempts survive view changes', () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    ipcOn.mockImplementation((channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    })
    const sync = startIpcSync()
    const a = tape('OrderTapeA', 10)
    const b = tape('OrderTapeB', 20)
    const owner = useOrderFailuresStore.getState()
    const attempt = owner.beginAttempt('inbox', [a, b])
    const boxAttempt = owner.beginAttempt('boxes', [{ id: 'SourceBox1', order: 10 }])
    try {
      const hydration = sync.beginHydration()
      const changed = { ...a, order: 3, title: 'Current title' }
      const boxes = [{ id: 'NewBox0001', name: 'Current box', order: 4 }]
      listeners.get('tapes:updated')!(changed)
      listeners.get('tapes:removed')!({ tapeIds: [b.id] })
      listeners.get('boxes:changed')!(boxes)
      expect(hydration.commit({
        tapes: [a, b], boxes: [{ id: 'SourceBox1', name: 'Stale box', order: 10 }], binaries: [],
        runtime: { platform: 'darwin', arch: 'arm64', version: '1.0.0' }, mediaBaseUrl: 'http://127.0.0.1:1234',
        layout: defaultLayout, settings: defaultSettings(),
      })).toBe(true)
      expect(owner.confirmedOrder('inbox')).toEqual([{ id: a.id, order: 3 }])
      expect(owner.confirmedOrder('boxes')).toEqual([{ id: boxes[0]!.id, order: 4 }])
      expect(useTapesStore.getState().tapes).toEqual([changed])
      expect(useBoxesStore.getState().boxes).toEqual(boxes)
    } finally {
      owner.finishAttempt('inbox', attempt)
      owner.finishAttempt('boxes', boxAttempt)
      sync.stop()
    }
  })

  it('keeps a notice on screen when main reports library changes are not reaching disk', () => {
    useToastStore.setState({ toasts: [] })
    const listeners = new Map<string, (payload: unknown) => void>()
    ipcOn.mockImplementation((channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener)
      return () => {}
    })
    const sync = startIpcSync()
    listeners.get('library:saveFailed')!(null)
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ text: LIBRARY_SAVE_FAILED_MESSAGE, kind: 'error' }),
    ])
    sync.stop()
  })
})
