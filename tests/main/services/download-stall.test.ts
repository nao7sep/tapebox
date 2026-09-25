import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isPostProcessingLine, watchForStall } from '@main/services/download-stall'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('download stall watch', () => {
  it('reports a silent transfer as stalled and clears it when output resumes', () => {
    const changes: boolean[] = []
    const watch = watchForStall((stalled) => changes.push(stalled), 1_000)
    vi.advanceTimersByTime(900)
    watch.line('tapebox-progress: 10.0%|1000|30')
    vi.advanceTimersByTime(900)
    expect(changes).toEqual([])
    vi.advanceTimersByTime(200)
    expect(changes).toEqual([true])
    watch.line('tapebox-progress: 11.0%|1000|29')
    expect(changes).toEqual([true, false])
    watch.stop()
  })

  it('never reports the silent post-processing merge as a stall', () => {
    const changes: boolean[] = []
    const watch = watchForStall((stalled) => changes.push(stalled), 1_000)
    watch.line('[Merger] Merging formats into "abc.mp4"')
    vi.advanceTimersByTime(60_000)
    expect(changes).toEqual([])
    watch.stop()
  })

  it('clears a reported stall when the download ends', () => {
    const changes: boolean[] = []
    const watch = watchForStall((stalled) => changes.push(stalled), 1_000)
    vi.advanceTimersByTime(1_000)
    watch.stop()
    vi.advanceTimersByTime(5_000)
    expect(changes).toEqual([true, false])
  })

  it('recognizes post-processor lines only', () => {
    expect(isPostProcessingLine('[Merger] Merging formats into "x.mp4"')).toBe(true)
    expect(isPostProcessingLine('[FixupM3u8] Fixing MPEG-TS in MP4 container')).toBe(true)
    expect(isPostProcessingLine('[download] Destination: x.f137.mp4')).toBe(false)
    expect(isPostProcessingLine('[youtube] abc: Downloading webpage')).toBe(false)
  })
})
