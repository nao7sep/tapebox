// @vitest-environment jsdom
import { act, createElement, StrictMode, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TapeSchema, type Box, type Tape } from '@shared/domain'
import type { BinaryStatus, IpcCalls, IpcEvents } from '@shared/ipc-contract'
import { defaultLayout, HEADER_HEIGHT } from '@shared/layout'
import { defaultSettings } from '@shared/settings'

const { ipcInvoke, ipcOn, logError } = vi.hoisted(() => ({ ipcInvoke: vi.fn(), ipcOn: vi.fn(), logError: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke, ipcOn }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: logError, warn: vi.fn() } }))

// The actual App startup owner, IPC sync and stores run together. Unrelated
// mounted shell controls are stubs so their separate effects do not own this test.
vi.mock('@renderer/lib/usePaneSize', () => ({ usePaneSize: () => ({ displayed: 400 }) }))
vi.mock('@renderer/lib/useTapeRemoval', () => ({ useTapeRemoval: () => ({ requestRemove: vi.fn(), confirmModal: null }) }))
vi.mock('@renderer/lib/useAppShortcuts', () => ({ useAppShortcuts: () => {} }))
vi.mock('@renderer/lib/useImportMedia', () => ({ useImportMedia: () => vi.fn() }))
vi.mock('@renderer/lib/useUiFont', () => ({ useUiFont: () => {} }))
vi.mock('@renderer/components/ResizeHandle', () => ({ ResizeHandle: () => null }))
vi.mock('@renderer/components/PassiveScrollRegion', () => ({ PassiveScrollRegion: ({ children }: { children: ReactNode }) => children }))
vi.mock('@renderer/components/BinariesModal', () => ({ BinariesModal: () => null }))
vi.mock('@renderer/components/TopBar', () => ({ TopBar: () => null }))
vi.mock('@renderer/components/TapeList', () => ({ TapeList: () => createElement('div', { 'data-hydrated-shell': true }) }))
vi.mock('@renderer/components/ArchiveOrganizer', () => ({ ArchiveOrganizer: () => null }))
vi.mock('@renderer/components/DetailPane', () => ({ DetailPane: () => null }))
vi.mock('@renderer/components/FilterChips', () => ({ FilterChips: () => null }))
vi.mock('@renderer/components/PlaybackToggles', () => ({ PlaybackSettingResults: () => null, PlaybackToggles: () => null }))
vi.mock('@renderer/components/ScanPageModal', () => ({ ScanPageModal: () => null }))
vi.mock('@renderer/components/SettingsModal', () => ({ SettingsModal: () => null }))
vi.mock('@renderer/components/AboutModal', () => ({ AboutModal: () => null }))
vi.mock('@renderer/components/ShortcutsModal', () => ({ ShortcutsModal: () => null }))
vi.mock('@renderer/components/HeaderMenu', () => ({ HeaderMenu: () => null }))
vi.mock('@renderer/components/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('@renderer/components/Toaster', () => ({ Toaster: () => null }))
vi.mock('@renderer/components/TapeImportReceiver', () => ({ TapeImportReceiver: ({ children }: { children: ReactNode }) => children }))
vi.mock('@renderer/components/LayoutWriteResult', () => ({ LayoutWriteResult: () => null }))
vi.mock('@renderer/components/WindowCloseGuard', () => ({ WindowCloseGuard: () => null }))

import App from '@renderer/App'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useBinariesStore } from '@renderer/store/binaries'
import { useRuntimeStore } from '@renderer/store/runtime'
import { useMediaStore } from '@renderer/store/media'
import { useLayoutStore } from '@renderer/store/layout'
import { useSettingsStore } from '@renderer/store/settings'
import { useDownloadLogStore } from '@renderer/store/downloadLog'
import { loadAllCatalogues } from '../helpers/i18n'

await loadAllCatalogues()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function tape(overrides: Partial<Tape> = {}): Tape {
  return TapeSchema.parse({
    id: 'Hydrate001', sourceUrl: 'https://example.com/watch?v=hydration', state: 'downloading',
    addedAtUtc: '2026-10-11T00:00:00.000Z', sourceId: null, extractor: null, title: 'Before download', uploader: null,
    durationSeconds: null, chapterCount: null, probedAtUtc: null, filename: null, sidecarFilename: null,
    thumbnailFilename: null, downloadStartedAtUtc: null, downloadedAtUtc: null, name: null, renamedAtUtc: null,
    archivedAtUtc: null, boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
    ...overrides,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const listeners = new Map<string, (payload: unknown) => void>()
const answers = new Map<keyof IpcCalls, unknown | (() => Promise<unknown>)>()
let root: Root | null = null

beforeEach(() => {
  ipcInvoke.mockReset()
  ipcOn.mockReset()
  logError.mockReset()
  listeners.clear()
  answers.clear()
  answers.set('library:list', [tape()])
  answers.set('boxes:list', [])
  answers.set('binaries:status', [])
  answers.set('app:runtimeInfo', { platform: 'darwin', arch: 'arm64', version: '1.0.0' })
  answers.set('media:endpoint', { baseUrl: 'http://127.0.0.1:1234' })
  answers.set('layout:get', defaultLayout)
  answers.set('settings:get', { ...defaultSettings(), checkUpdatesAtLaunch: false })
  ipcInvoke.mockImplementation((channel: keyof IpcCalls) => {
    const value = answers.get(channel)
    return typeof value === 'function' ? value() : Promise.resolve(value)
  })
  ipcOn.mockImplementation((channel: string, listener: (payload: unknown) => void) => {
    listeners.set(channel, listener)
    return () => { if (listeners.get(channel) === listener) listeners.delete(channel) }
  })
  useTapesStore.setState({ tapes: [], progress: {}, stalled: {} })
  useBoxesStore.setState({ boxes: [] })
  useBinariesStore.setState({ statuses: [], progress: {}, active: {}, modalOpen: false })
  useRuntimeStore.setState({ info: null })
  useMediaStore.setState({ baseUrl: null })
  useLayoutStore.setState({ layout: null, persistedLayout: null, writeErrors: {} })
  useSettingsStore.setState({ settings: null, writeErrors: {}, saving: {} })
  useDownloadLogStore.setState({ entries: {} })
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

async function mount(strict = false) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const app = createElement(App)
  await act(async () => root!.render(strict ? createElement(StrictMode, null, app) : app))
}

function emit<K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]) {
  expect(listeners.has(channel)).toBe(true)
  listeners.get(channel)!(payload)
}

const shellMounted = () => document.querySelector('[data-hydrated-shell]') !== null

describe('App hydration and live IPC handoff', () => {
  it('keeps the downloaded tape and clears its progress when completion follows an earlier tape snapshot', async () => {
    const binaries = deferred<BinaryStatus[]>()
    answers.set('binaries:status', () => binaries.promise)
    await mount()
    expect(shellMounted()).toBe(false)
    const downloaded = tape({ state: 'downloaded', filename: 'Hydrate001.mp4', downloadedAtUtc: '2026-10-11T00:01:00.000Z' })

    emit('tapes:progress', { tapeId: downloaded.id, phase: 'downloading', percent: 67 })
    emit('tapes:log', { tapeId: downloaded.id, line: 'finished writing media' })
    emit('tapes:updated', downloaded)
    emit('tapes:completed', { tapeId: downloaded.id })
    await act(async () => binaries.resolve([]))

    expect(shellMounted()).toBe(true)
    expect(useTapesStore.getState().tapes).toEqual([downloaded])
    expect(useTapesStore.getState().progress).toEqual({})
    expect(useDownloadLogStore.getState().entries).toEqual({})
  })

  // The window minimum reserves the header's height, which the header takes.
  it('gives the header the height the window minimum reserves', async () => {
    await mount()
    await vi.waitFor(() => expect(shellMounted()).toBe(true))
    expect(document.querySelector<HTMLElement>('main > header')!.style.height).toBe(`${HEADER_HEIGHT}px`)
  })

  it('replays additions, latest bulk updates, removals and boxes over the initial snapshot', async () => {
    const binaries = deferred<BinaryStatus[]>()
    const removed = tape({ id: 'Hydrate002' })
    answers.set('library:list', [tape(), removed])
    answers.set('boxes:list', [{ id: 'HydrateBox', name: 'Old box', order: 0 }])
    answers.set('binaries:status', () => binaries.promise)
    await mount()
    const added = tape({ id: 'Hydrate003', title: 'Added while loading' })
    const newest = tape({ title: 'Latest title' })
    const boxes: Box[] = [{ id: 'HydrateBox', name: 'Renamed while loading', order: 0 }]

    emit('tapes:added', [added])
    emit('tapes:updated', tape({ title: 'Intermediate title' }))
    emit('tapes:updatedMany', [newest])
    emit('tapes:removed', { tapeIds: [removed.id] })
    emit('boxes:changed', boxes)
    await act(async () => binaries.resolve([]))

    expect(useTapesStore.getState().tapes).toEqual([newest, added])
    expect(useBoxesStore.getState().boxes).toEqual(boxes)
    // Events after the handoff still use the same subscriptions.
    await act(async () => emit('tapes:removed', { tapeIds: [added.id] }))
    expect(useTapesStore.getState().tapes).toEqual([newest])
  })

  it('leaves a failed required load uncommitted and preserves retry-period updates', async () => {
    const failedBinaries = deferred<BinaryStatus[]>()
    answers.set('binaries:status', () => failedBinaries.promise)
    await mount()
    emit('tapes:updated', tape({ title: 'An earlier attempt event' }))
    emit('tapes:added', [tape({ id: 'Hydrate004', title: 'Only in the failed attempt' })])
    await act(async () => failedBinaries.reject(new Error('EACCES /private/tmp/HYDRATION_SENTINEL')))

    expect(shellMounted()).toBe(false)
    expect(useLayoutStore.getState().layout).toBeNull()
    expect(useSettingsStore.getState().settings).toBeNull()
    expect(useMediaStore.getState().baseUrl).toBeNull()
    expect(document.body.textContent).not.toContain('HYDRATION_SENTINEL')
    const retryBinaries = deferred<BinaryStatus[]>()
    answers.set('binaries:status', () => retryBinaries.promise)
    answers.set('library:list', [tape({ title: 'New retry snapshot' })])
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
    const latest = tape({ state: 'downloaded', title: 'Retry completed' })
    emit('tapes:updated', latest)
    emit('tapes:completed', { tapeId: latest.id })
    await act(async () => retryBinaries.resolve([]))

    expect(shellMounted()).toBe(true)
    expect(useTapesStore.getState().tapes).toEqual([latest])
    expect(useLayoutStore.getState().layout).toEqual(defaultLayout)
    expect(ipcOn.mock.calls.filter(([channel]) => channel === 'tapes:updated')).toHaveLength(1)
  })

  it('ignores an obsolete generation when a replacement subscription hydrates first', async () => {
    const first = deferred<BinaryStatus[]>()
    const second = deferred<BinaryStatus[]>()
    let attempts = 0
    answers.set('binaries:status', () => (++attempts === 1 ? first.promise : second.promise))
    await mount(true)
    expect(attempts).toBe(2)
    const current = tape({ title: 'Current generation' })
    emit('tapes:updated', current)
    await act(async () => second.resolve([]))
    expect(useTapesStore.getState().tapes).toEqual([current])
    await act(async () => first.resolve([]))
    expect(useTapesStore.getState().tapes).toEqual([current])
  })

  it('unsubscribes on unmount and cannot publish the pending snapshot afterwards', async () => {
    const binaries = deferred<BinaryStatus[]>()
    answers.set('binaries:status', () => binaries.promise)
    await mount()
    emit('tapes:updated', tape({ title: 'Before unmount' }))
    await act(async () => root!.unmount())
    root = null
    expect(listeners.size).toBe(0)
    await act(async () => binaries.resolve([]))
    expect(useTapesStore.getState().tapes).toEqual([tape({ title: 'Before unmount' })])
    expect(useLayoutStore.getState().layout).toBeNull()
  })
})
