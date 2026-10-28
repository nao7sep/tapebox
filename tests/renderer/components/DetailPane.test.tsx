// @vitest-environment jsdom
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'
import { defaultLayout } from '@shared/layout'
import { defaultSettings } from '@shared/settings'
import { useMediaStore } from '@renderer/store/media'
import { useLayoutStore } from '@renderer/store/layout'
import { useSettingsStore } from '@renderer/store/settings'
import { releaseVideo } from '@renderer/lib/video'

const { ipcInvoke, logError } = vi.hoisted(() => ({ ipcInvoke: vi.fn(), logError: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke, ipcOn: () => () => {} }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: logError, debug: vi.fn(), warn: vi.fn() } }))

import { DetailPane } from '@renderer/components/DetailPane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null
let host: HTMLDivElement
let tape: Tape
let videoRef = createRef<HTMLVideoElement>()
const states = new WeakMap<HTMLMediaElement, { paused: boolean; ended: boolean }>()
const play = vi.fn(function (this: HTMLMediaElement) {
  states.set(this, { paused: false, ended: false })
  this.dispatchEvent(new Event('play'))
  return Promise.resolve()
})
const pause = vi.fn(function (this: HTMLMediaElement) {
  states.set(this, { paused: true, ended: false })
  this.dispatchEvent(new Event('pause'))
})
const load = vi.fn(function (this: HTMLMediaElement) { this.dispatchEvent(new Event('emptied')) })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function render(next = tape) {
  tape = next
  await act(async () => root!.render(createElement(DetailPane, {
    tape, videoRef, onRequestRemove: () => {}, onScanPage: () => {},
  })))
}

function video() {
  if (!videoRef.current) throw new Error('No video mounted')
  return videoRef.current
}

async function click(label: string, dialog = false) {
  const scope = dialog ? document.querySelector('[role="dialog"]')! : host
  const button = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!button) throw new Error(`No button labelled ${label}`)
  await act(async () => button.click())
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(load)
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement) { return states.get(this)?.paused ?? true })
  vi.spyOn(HTMLMediaElement.prototype, 'ended', 'get').mockImplementation(function (this: HTMLMediaElement) { return states.get(this)?.ended ?? false })
  play.mockClear(); pause.mockClear(); load.mockClear()
  ipcInvoke.mockReset().mockImplementation(async (channel: string, req: unknown) => {
    if (channel === 'library:getSidecar') return {}
    if (channel === 'settings:update') return { settings: { ...useSettingsStore.getState().settings, ...req as object }, warning: null }
    return undefined
  })
  useMediaStore.setState({ baseUrl: 'http://localhost/media', collectionRevision: 0 })
  useLayoutStore.getState().setHydratedLayout(defaultLayout)
  useSettingsStore.getState().setHydratedSettings({ ...defaultSettings(), autoplay: true, volume: 0.7 })
  tape = { id: 'Tape000001', title: 'Title', sourceUrl: 'https://example.com/video', state: 'downloaded', filename: 'old.mp4', sidecarFilename: 'old.info.json', name: 'Old', probedAtUtc: '2026-10-23T00:00:00Z' } as Tape
  videoRef = createRef<HTMLVideoElement>()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DetailPane media lifecycle', () => {
  it.each([
    { playing: true, ended: false, fails: false },
    { playing: false, ended: false, fails: false },
    { playing: true, ended: false, fails: true },
    { playing: false, ended: false, fails: true },
    { playing: false, ended: true, fails: false },
    { playing: false, ended: true, fails: true },
  ])('restores rename position and play intent: %j', async ({ playing, ended, fails }) => {
    // An opposite global preference proves the rename snapshot owns this remount.
    useSettingsStore.setState({ settings: { ...defaultSettings(), autoplay: !playing, volume: 0.7 } })
    const rename = deferred<void>()
    ipcInvoke.mockImplementation((channel: string) => channel === 'library:rename' ? rename.promise : Promise.resolve({}))
    await render()
    expect(video().autoplay).toBe(!playing)
    const old = video()
    old.currentTime = 37
    states.set(old, { paused: !playing, ended })
    await click('Rename')
    await click('Rename', true)
    expect(videoRef.current).toBeNull()
    expect(old.hasAttribute('src')).toBe(false)
    expect(pause.mock.contexts).toContain(old)
    expect(load.mock.contexts).toContain(old)
    expect(ipcInvoke).toHaveBeenCalledWith('app:setVideoPlaying', { playing: false })
    await act(async () => {
      if (fails) rename.reject(new Error('rename rejected'))
      else {
        tape = { ...tape, filename: 'new.mp4' }
        await render()
        rename.resolve()
      }
    })
    const restored = video()
    expect(restored).not.toBe(old)
    expect(restored.autoplay).toBe(playing)
    expect(restored.src).toContain(fails ? 'old.mp4' : 'new.mp4')
    play.mockClear()
    await act(async () => restored.dispatchEvent(new Event('loadedmetadata', { bubbles: true })))
    expect(restored.currentTime).toBe(37)
    expect(play).toHaveBeenCalledTimes(playing ? 1 : 0)
    if (fails) expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    else expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('releases playback and flushes the final volume on source switch and unmount', async () => {
    await render()
    const first = video()
    expect(first.volume).toBe(0.7)
    await act(async () => { await first.play(); first.volume = 0.4; first.dispatchEvent(new Event('volumechange')) })
    expect(useSettingsStore.getState().settings?.volume).toBe(0.4)
    await act(async () => releaseVideo(first))
    expect(ipcInvoke).toHaveBeenLastCalledWith('app:setVideoPlaying', { playing: false })
    await render({ ...tape, id: 'Tape000002', filename: 'second.mp4' })
    expect(video().volume).toBe(0.4)
    expect(ipcInvoke).toHaveBeenCalledWith('settings:update', { volume: 0.4 })
    ipcInvoke.mockClear()
    await act(async () => first.dispatchEvent(new Event('play')))
    expect(ipcInvoke).not.toHaveBeenCalled()
    const second = video()
    await act(async () => { await second.play(); second.volume = 0.2; second.dispatchEvent(new Event('volumechange')) })
    await act(async () => root!.unmount()); root = null
    expect(ipcInvoke).toHaveBeenCalledWith('settings:update', { volume: 0.2 })
    expect(ipcInvoke).toHaveBeenCalledWith('app:setVideoPlaying', { playing: false })
  })

  it('reloads accepted metadata and prefers the probed durationSeconds', async () => {
    ipcInvoke.mockImplementation(async (channel: string) => channel === 'library:getSidecar'
      ? { duration: 60, tapebox: { media: { durationSeconds: tape.probedAtUtc?.endsWith('01Z') ? 135 : 90 } } }
      : undefined)
    await render()
    expect(host.textContent).toContain('1:30')
    await render({ ...tape, probedAtUtc: '2026-10-23T00:00:01Z' })
    expect(host.textContent).toContain('2:15')
    expect(ipcInvoke.mock.calls.filter(([c]) => c === 'library:getSidecar')).toHaveLength(2)
  })

  it('ignores sidecar replies after tape or collection replacement', async () => {
    const requests = [deferred<object>(), deferred<object>(), deferred<object>()]
    let index = 0
    ipcInvoke.mockImplementation((channel: string) => channel === 'library:getSidecar' ? requests[index++].promise : Promise.resolve())
    await render()
    await render({ ...tape, id: 'Tape000002' })
    await act(async () => useMediaStore.setState({ collectionRevision: 1 }))
    await act(async () => requests[2].resolve({ ext: 'current' }))
    expect(host.textContent).toContain('current')
    await act(async () => { requests[0].resolve({ ext: 'stale tape' }); requests[1].resolve({ ext: 'stale collection' }) })
    expect(host.textContent).toContain('current')
    expect(host.textContent).not.toContain('stale')
  })
})


describe('selected-tape keyboard ownership', () => {
  it('leaves Enter activation to every focused detail button', async () => {
    await render()
    play.mockClear(); pause.mockClear()
    const buttons = [...host.querySelectorAll('button')]
    expect(buttons.some(button => button.textContent === 'Rename')).toBe(true)
    expect(buttons.some(button => button.textContent === 'Export')).toBe(true)
    for (const button of buttons) {
      button.focus()
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      await act(async () => button.dispatchEvent(event))
      expect(event.defaultPrevented).toBe(false)
    }
    expect(play).not.toHaveBeenCalled()
    expect(pause).not.toHaveBeenCalled()
  })

  it('retains background Enter and yields composition', async () => {
    await render()
    play.mockClear()
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
      await act(async () => host.dispatchEvent(event))
      expect(event.defaultPrevented).toBe(false)
    }
    expect(play).not.toHaveBeenCalled()
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => host.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(play).toHaveBeenCalledOnce()
  })
})


it('turns the native mute button into volume zero', async () => {
  await render()
  const current = video()
  await act(async () => { current.muted = true; current.dispatchEvent(new Event('volumechange')) })
  expect(current.muted).toBe(false)
  expect(current.volume).toBe(0)
  await act(async () => current.dispatchEvent(new Event('volumechange')))
  expect(useSettingsStore.getState().settings?.volume).toBe(0)
})

it('applies rejected volume rollback to the live element without an echo save', async () => {
  vi.useFakeTimers()
  try {
    await render()
    const current = video()
    ipcInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'settings:update') throw new Error('volume rejected')
      return {}
    })
    await act(async () => { current.volume = 0.2; current.dispatchEvent(new Event('volumechange')) })
    expect(useSettingsStore.getState().settings?.volume).toBe(0.2)
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(useSettingsStore.getState().settings?.volume).toBe(0.7)
    expect(current.volume).toBe(0.7)
    await act(async () => current.dispatchEvent(new Event('volumechange')))
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(ipcInvoke.mock.calls.filter(([channel]) => channel === 'settings:update')).toHaveLength(1)
  } finally { vi.useRealTimers() }
})

it('logs tape identity and masks the local media credential in browser diagnostics', async () => {
  useMediaStore.setState({ baseUrl: 'http://localhost/SECRET_MEDIA_TOKEN' })
  await render()
  const current = video()
  Object.defineProperty(current, 'error', { value: { code: 3, message: `Decode failed for ${current.src}` } })
  logError.mockClear()
  await act(async () => current.dispatchEvent(new Event('error')))
  expect(logError).toHaveBeenCalledWith('media playback failed', expect.objectContaining({
    tapeId: tape.id, mediaFilename: 'old.mp4', browserMessage: expect.stringContaining('[REDACTED]'),
  }))
  expect(JSON.stringify(logError.mock.calls)).not.toContain('SECRET_MEDIA_TOKEN')
  expect(logError.mock.calls[0]![1]).not.toHaveProperty('source')
})

describe('shared sidecar preview', () => {
  const reads = () => ipcInvoke.mock.calls.filter(([channel]) => channel === 'library:getSidecar')

  it('shares the settled preview with Rename and invalidates it on accepted metadata and collection changes', async () => {
    ipcInvoke.mockImplementation(async (channel: string) => channel === 'library:getSidecar' ? { description: 'Saved description' } : undefined)
    await render()
    await click('Rename')
    expect(reads()).toHaveLength(1)
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Saved description')
    const descriptionToggle = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')].at(-1)!
    expect(descriptionToggle.checked).toBe(true)
    await click('Cancel', true)
    await render({ ...tape, probedAtUtc: '2026-10-24T00:00:00Z' })
    expect(reads()).toHaveLength(2)
    await act(async () => useMediaStore.setState({ collectionRevision: 1 }))
    expect(reads()).toHaveLength(3)
  })

  it('shares an unfinished read and lets a tool retry the shared failure once', async () => {
    const pending = deferred<Record<string, unknown>>()
    ipcInvoke.mockImplementation((channel: string) => channel === 'library:getSidecar' ? pending.promise : Promise.resolve())
    await render()
    await click('Rename')
    expect(reads()).toHaveLength(1)
    await act(async () => pending.reject(new Error('unavailable')))
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('[role="alert"]')).not.toBeNull()
    ipcInvoke.mockImplementation(async (channel: string) => channel === 'library:getSidecar' ? { description: 'Recovered preview' } : undefined)
    await click('Try again', true)
    expect(reads()).toHaveLength(2)
    expect(dialog.textContent).toContain('Recovered preview')
    expect(dialog.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector('[aria-label="Chapter load error"]')).toBeNull()
  })
})
