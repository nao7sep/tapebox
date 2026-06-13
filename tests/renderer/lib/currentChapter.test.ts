// @vitest-environment jsdom
import React, { act, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { chapterIndexForTime, useCurrentChapter } from '@renderer/lib/currentChapter'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const chapters = [{ start_time: 0 }, { start_time: 30 }, { start_time: 90 }]

describe('chapterIndexForTime', () => {
  it('returns the last chapter starting at or before t', () => {
    expect(chapterIndexForTime(chapters, 0)).toBe(0)
    expect(chapterIndexForTime(chapters, 29.9)).toBe(0)
    expect(chapterIndexForTime(chapters, 30)).toBe(1)
    expect(chapterIndexForTime(chapters, 95)).toBe(2)
  })

  it('treats the first chapter as current before its start (e.g. chapters start > 0)', () => {
    expect(chapterIndexForTime([{ start_time: 5 }, { start_time: 10 }], 0)).toBe(0)
  })

  it('stays on the last chapter past the final start', () => {
    expect(chapterIndexForTime(chapters, 100000)).toBe(2)
  })

  it('returns -1 when there are no chapters', () => {
    expect(chapterIndexForTime([], 42)).toBe(-1)
  })
})

// Minimal stand-in for the <video>: a settable currentTime and the event plumbing
// the hook subscribes to. The hook touches nothing else.
function fakeVideo() {
  const listeners: Record<string, Set<() => void>> = {}
  return {
    currentTime: 0,
    addEventListener(type: string, fn: () => void) { (listeners[type] ??= new Set()).add(fn) },
    removeEventListener(type: string, fn: () => void) { listeners[type]?.delete(fn) },
    dispatch(type: string) { listeners[type]?.forEach((fn) => fn()) },
  }
}

let root: Root | null = null
let captured = -2
let renders = 0

function Harness({ videoRef, chapters, srcKey }: {
  videoRef: RefObject<HTMLVideoElement | null>
  chapters: { start_time: number }[]
  srcKey: string
}): null {
  renders++
  captured = useCurrentChapter(videoRef, chapters, srcKey)
  return null
}

async function mount(videoRef: RefObject<HTMLVideoElement | null>, chs: { start_time: number }[]): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(React.createElement(Harness, { videoRef, chapters: chs, srcKey: 's1' }))
  })
}

afterEach(async () => {
  if (root !== null) {
    await act(async () => { root?.unmount() })
    root = null
  }
  captured = -2
  renders = 0
  document.body.innerHTML = ''
})

describe('useCurrentChapter', () => {
  it('derives the chapter from the playhead and follows timeupdate / seeked', async () => {
    const fv = fakeVideo()
    const ref = { current: fv } as unknown as RefObject<HTMLVideoElement | null>
    await mount(ref, chapters)
    expect(captured).toBe(0)

    fv.currentTime = 35
    await act(async () => { fv.dispatch('timeupdate') })
    expect(captured).toBe(1)

    fv.currentTime = 95
    await act(async () => { fv.dispatch('seeked') })
    expect(captured).toBe(2)
  })

  it('does not re-render while the playhead stays within the same chapter', async () => {
    const fv = fakeVideo()
    const ref = { current: fv } as unknown as RefObject<HTMLVideoElement | null>
    await mount(ref, chapters)
    fv.currentTime = 95
    await act(async () => { fv.dispatch('timeupdate') })
    expect(captured).toBe(2)

    const before = renders
    fv.currentTime = 120 // still chapter 2 — index unchanged
    await act(async () => { fv.dispatch('timeupdate') })
    expect(captured).toBe(2)
    expect(renders).toBe(before)
  })

  it('returns -1 when there are no chapters', async () => {
    const fv = fakeVideo()
    const ref = { current: fv } as unknown as RefObject<HTMLVideoElement | null>
    await mount(ref, [])
    expect(captured).toBe(-1)
  })
})
