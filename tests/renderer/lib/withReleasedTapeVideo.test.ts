// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'
import { withReleasedTapeVideo } from '@renderer/lib/withReleasedTapeVideo'
import { mediaFileUrl, useMediaStore } from '@renderer/store/media'
import { useSelectionStore } from '@renderer/store/selection'
import { useTapesStore } from '@renderer/store/tapes'

const tape = { id: 'video-owner', filename: 'video.mp4', state: 'downloaded' } as Tape
let video: HTMLVideoElement
let ref: { current: HTMLVideoElement | null }
let source: string
let play: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  useMediaStore.setState({ baseUrl: 'http://localhost/token', collectionRevision: 0 })
  useSelectionStore.setState({ selectedId: tape.id })
  useTapesStore.setState({ tapes: [tape] })
  video = document.createElement('video')
  source = mediaFileUrl(useMediaStore.getState(), tape.filename)!
  video.src = source
  video.currentTime = 37
  document.body.append(video)
  ref = { current: video }
  vi.spyOn(video, 'pause').mockImplementation(() => {})
  vi.spyOn(video, 'load').mockImplementation(() => {})
  play = vi.spyOn(video, 'play').mockResolvedValue(undefined)
})
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

it.each([true, false])('restores source, position and play intent after failure (playing=%s)', async (playing) => {
  vi.spyOn(video, 'paused', 'get').mockReturnValue(!playing)
  await expect(withReleasedTapeVideo(tape, ref, async () => {
    expect(video.hasAttribute('src')).toBe(false)
    throw new Error('file operation failed')
  })).rejects.toThrow('file operation failed')
  expect(video.src).toBe(source)
  expect(video.autoplay).toBe(playing)
  video.currentTime = 0
  video.dispatchEvent(new Event('loadedmetadata'))
  expect(video.currentTime).toBe(37)
  expect(play).toHaveBeenCalledTimes(playing ? 1 : 0)
})

it.each(['removed', 'selection', 'collection', 'replacement'])('does not restore after %s changes ownership', async (change) => {
  await withReleasedTapeVideo(tape, ref, async () => {
    if (change === 'removed') useTapesStore.setState({ tapes: [] })
    if (change === 'selection') useSelectionStore.setState({ selectedId: 'other' })
    if (change === 'collection') useMediaStore.setState({ collectionRevision: 1 })
    if (change === 'replacement') ref.current = document.createElement('video')
  })
  expect(video.hasAttribute('src')).toBe(false)
  expect(play).not.toHaveBeenCalled()
})

it('waits for overlapping operations before restoring the original snapshot', async () => {
  let finishFirst!: () => void
  let finishSecond!: () => void
  const first = withReleasedTapeVideo(tape, ref, () => new Promise<void>(resolve => { finishFirst = resolve }))
  const second = withReleasedTapeVideo(tape, ref, () => new Promise<void>(resolve => { finishSecond = resolve }))
  expect(video.pause).toHaveBeenCalledOnce()
  finishFirst()
  await first
  expect(video.hasAttribute('src')).toBe(false)
  finishSecond()
  await second
  expect(video.src).toBe(source)
  video.currentTime = 0
  video.dispatchEvent(new Event('loadedmetadata'))
  expect(video.currentTime).toBe(37)
})

it('does not release an unrelated playing tape', async () => {
  await withReleasedTapeVideo({ ...tape, filename: 'other.mp4' }, ref, async () => {})
  expect(video.pause).not.toHaveBeenCalled()
  expect(video.src).toBe(source)
})

it('does not resume an obsolete source when metadata arrives after selection changes', async () => {
  vi.spyOn(video, 'paused', 'get').mockReturnValue(false)
  await withReleasedTapeVideo(tape, ref, async () => {})
  useSelectionStore.setState({ selectedId: 'other' })
  video.currentTime = 0
  video.dispatchEvent(new Event('loadedmetadata'))
  expect(video.currentTime).toBe(0)
  expect(play).not.toHaveBeenCalled()
})
