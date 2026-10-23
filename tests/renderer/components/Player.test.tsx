// @vitest-environment jsdom
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Player } from '@renderer/components/Player'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let callbacks: Map<number, VideoFrameRequestCallback>
let nextId: number
const cancel = vi.fn()

beforeEach(() => {
  callbacks = new Map(); nextId = 1; cancel.mockClear()
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    value: (callback: VideoFrameRequestCallback) => { const id = nextId++; callbacks.set(id, callback); return id },
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', { configurable: true, value: cancel })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback
})

it('cancels the old source frame and ignores its late callback and metadata event', async () => {
  const ref = createRef<HTMLVideoElement>()
  const onLoadedMetadata = vi.fn()
  await act(async () => root.render(createElement(Player, { src: 'first.mp4', autoPlay: true, ref, onLoadedMetadata })))
  const first = ref.current!
  expect(first.classList.contains('opacity-0')).toBe(true)
  await act(async () => root.render(createElement(Player, { src: 'second.mp4', autoPlay: true, ref, onLoadedMetadata })))
  const second = ref.current!
  expect(second).not.toBe(first)
  expect(cancel).toHaveBeenCalledWith(1)
  await act(async () => {
    callbacks.get(1)!(0, {} as VideoFrameCallbackMetadata)
    first.dispatchEvent(new Event('loadedmetadata'))
  })
  expect(second.classList.contains('opacity-0')).toBe(true)
  expect(onLoadedMetadata).not.toHaveBeenCalled()
  await act(async () => callbacks.get(2)!(0, {} as VideoFrameCallbackMetadata))
  expect(second.classList.contains('opacity-100')).toBe(true)
  await act(async () => second.dispatchEvent(new Event('loadedmetadata', { bubbles: true })))
  expect(onLoadedMetadata).toHaveBeenCalledOnce()
})
