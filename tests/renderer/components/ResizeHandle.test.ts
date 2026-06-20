// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResizeHandle } from '@renderer/components/ResizeHandle'
import { LAYOUT_BOUNDS, detailPaneWidth } from '@shared/layout'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  document.body.innerHTML = ''
  document.body.style.userSelect = ''
})

/**
 * jsdom computes no layout, so the handle's live-container lookup
 * (`offsetParent.parentElement`) and the container's `clientWidth` are stubbed to
 * model a flex row: an outer container of `available` px holding the resized pane,
 * which holds the handle. The handle reads the container width at drag start, so
 * stubbing it drives the real clamp path the component uses in production.
 */
function mountWithContainer(props: {
  edge: 'left' | 'right'
  size: number
  min: number
  max: number
  siblingMin: number
  available: number
  onResize: (n: number) => void
  onCommit: (n: number) => void
}) {
  const { available, ...handleProps } = props
  root = createRoot(container)
  act(() => {
    root!.render(React.createElement(ResizeHandle, handleProps))
  })
  const handle = container.querySelector('[role="separator"]') as HTMLElement
  // pane = the handle's positioned ancestor; outer = the flex container.
  const pane = document.createElement('div')
  const outer = document.createElement('div')
  Object.defineProperty(outer, 'clientWidth', { value: available, configurable: true })
  outer.append(pane)
  // jsdom returns null for offsetParent; point it at the pane whose parent is the
  // flex container, matching the real DOM nesting the component walks.
  Object.defineProperty(handle, 'offsetParent', { value: pane, configurable: true })
  return handle
}

function drag(handle: HTMLElement, fromX: number, toX: number): void {
  act(() => {
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: fromX, bubbles: true }))
  })
  act(() => {
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: toX }))
  })
  act(() => {
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: toX }))
  })
}

describe('ResizeHandle drag clamping', () => {
  it('caps a left-pane widening drag at container − siblingMin, not the absolute max', () => {
    const onResize = vi.fn()
    const onCommit = vi.fn()
    // A real-shaped narrow window: at the window minimum width, the left pane can
    // only ever reach its own minimum — the siblings (detail + chapters mins) eat
    // the rest. A drag far past that is capped at the boundary, not leftPane.max.
    const available = LAYOUT_BOUNDS.leftPaneWidth.min + detailPaneWidth.min + LAYOUT_BOUNDS.chaptersPaneWidth.min
    const handle = mountWithContainer({
      edge: 'right',
      size: LAYOUT_BOUNDS.leftPaneWidth.min,
      min: LAYOUT_BOUNDS.leftPaneWidth.min,
      max: LAYOUT_BOUNDS.leftPaneWidth.max,
      siblingMin: detailPaneWidth.min + LAYOUT_BOUNDS.chaptersPaneWidth.min,
      available,
      onResize,
      onCommit,
    })

    // Drag the right edge far to the right (tries to grow the left pane huge).
    drag(handle, 0, 5000)

    const committed = onCommit.mock.calls.at(-1)?.[0] as number
    // Capped at the boundary (its own min here), never the absolute max.
    expect(committed).toBe(LAYOUT_BOUNDS.leftPaneWidth.min)
    expect(committed).toBeLessThan(LAYOUT_BOUNDS.leftPaneWidth.max)
  })

  it('on a wide window the same drag stops at container − siblingMin', () => {
    const onResize = vi.fn()
    const onCommit = vi.fn()
    // Wide enough that the boundary (container − siblingMin) is a real interior
    // value, below the pane's absolute max — the drag must stop there.
    const siblingMin = detailPaneWidth.min + LAYOUT_BOUNDS.chaptersPaneWidth.min
    const available = 1000
    const handle = mountWithContainer({
      edge: 'right',
      size: LAYOUT_BOUNDS.leftPaneWidth.min,
      min: LAYOUT_BOUNDS.leftPaneWidth.min,
      max: LAYOUT_BOUNDS.leftPaneWidth.max,
      siblingMin,
      available,
      onResize,
      onCommit,
    })

    drag(handle, 0, 5000)

    const committed = onCommit.mock.calls.at(-1)?.[0] as number
    expect(committed).toBe(available - siblingMin)
    expect(committed).toBeLessThan(LAYOUT_BOUNDS.leftPaneWidth.max)
  })
})
