import { beforeEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  active: new Set<number>(),
  next: 0,
  enabled: true,
  start: vi.fn(),
  stop: vi.fn(),
}))
vi.mock('electron', () => ({ powerSaveBlocker: {
  start: native.start,
  stop: native.stop,
  isStarted: (id: number) => native.active.has(id),
} }))
vi.mock('@main/store/config', () => ({ getSettings: () => ({ keepAwakeWhilePlaying: native.enabled }) }))
vi.mock('@main/io/logger', () => ({ log: { debug: vi.fn() } }))
import { reconcileWakeLock, releaseWakeLock, setVideoPlaying } from '@main/power-blocker'

beforeEach(() => {
  releaseWakeLock()
  native.active.clear()
  native.enabled = true
  native.start.mockReset().mockImplementation(() => { const id = ++native.next; native.active.add(id); return id })
  native.stop.mockReset().mockImplementation((id: number) => native.active.delete(id))
})

it('holds exactly one assertion and releases it once across repeated play/pause reports', () => {
  setVideoPlaying(true)
  setVideoPlaying(true)
  reconcileWakeLock()
  expect(native.start).toHaveBeenCalledExactlyOnceWith('prevent-display-sleep')
  expect(native.active.size).toBe(1)
  setVideoPlaying(false)
  setVideoPlaying(false)
  releaseWakeLock()
  expect(native.stop).toHaveBeenCalledOnce()
  expect(native.active.size).toBe(0)
})

it('reconciles setting changes against retained playback intent', () => {
  setVideoPlaying(true)
  native.enabled = false
  reconcileWakeLock()
  expect(native.active.size).toBe(0)
  native.enabled = true
  reconcileWakeLock()
  expect(native.active.size).toBe(1)
  releaseWakeLock()
  reconcileWakeLock()
  expect(native.active.size).toBe(0)
})

it('reacquires an externally lost assertion without accumulating holds', () => {
  setVideoPlaying(true)
  native.active.clear()
  reconcileWakeLock()
  expect(native.start).toHaveBeenCalledTimes(2)
  expect(native.active.size).toBe(1)
})
