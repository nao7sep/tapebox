// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResizeHandle } from '@renderer/components/ResizeHandle'
import { LAYOUT_BOUNDS } from '@shared/layout'

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
 * The handle reports the pane's INTENT — the size the drag reaches for, bounded
 * only by the pane's own min/max. It does NOT clamp against the live container
 * (that's the consumer's derivation, usePaneSize → clampSplitter), so the test
 * needs no container stub: only the pane's own bounds gate the drag.
 */
function mount(props: {
  edge: 'left' | 'right'
  size: number
  min: number
  max: number
  onResize: (n: number) => void
  onCommit: (n: number) => void
}) {
  root = createRoot(container)
  act(() => {
    root!.render(React.createElement(ResizeHandle, props))
  })
  return container.querySelector('[role="separator"]') as HTMLElement
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

describe('ResizeHandle intent drag', () => {
  it('reports the dragged intent capped at the pane max, ignoring the container', () => {
    const onResize = vi.fn()
    const onCommit = vi.fn()
    // The handle takes no container/siblingMin: a drag far past the pane max is
    // capped at the pane's OWN max — the intent the consumer then clamps to the
    // live container when it derives the displayed size. A would-be-starving
    // window is the derivation's concern, not the handle's.
    const handle = mount({
      edge: 'right',
      size: LAYOUT_BOUNDS.leftPaneWidth.min,
      min: LAYOUT_BOUNDS.leftPaneWidth.min,
      max: LAYOUT_BOUNDS.leftPaneWidth.max,
      onResize,
      onCommit,
    })

    drag(handle, 0, 5000)

    const committed = onCommit.mock.calls.at(-1)?.[0] as number
    expect(committed).toBe(LAYOUT_BOUNDS.leftPaneWidth.max)
  })

  it('floors a shrinking drag at the pane min', () => {
    const onResize = vi.fn()
    const onCommit = vi.fn()
    const handle = mount({
      edge: 'right',
      size: LAYOUT_BOUNDS.leftPaneWidth.default,
      min: LAYOUT_BOUNDS.leftPaneWidth.min,
      max: LAYOUT_BOUNDS.leftPaneWidth.max,
      onResize,
      onCommit,
    })

    // Drag the right edge far to the left — the intent floors at the pane min.
    drag(handle, 1000, -5000)

    const committed = onCommit.mock.calls.at(-1)?.[0] as number
    expect(committed).toBe(LAYOUT_BOUNDS.leftPaneWidth.min)
  })

  it('passes an in-range drag through as the new intent', () => {
    const onResize = vi.fn()
    const onCommit = vi.fn()
    const start = LAYOUT_BOUNDS.leftPaneWidth.default
    const handle = mount({
      edge: 'right',
      size: start,
      min: LAYOUT_BOUNDS.leftPaneWidth.min,
      max: LAYOUT_BOUNDS.leftPaneWidth.max,
      onResize,
      onCommit,
    })

    // +40px to the right grows the pane by 40, well within [min, max].
    drag(handle, 100, 140)

    expect(onResize).toHaveBeenLastCalledWith(start + 40)
    expect(onCommit).toHaveBeenLastCalledWith(start + 40)
  })
})
