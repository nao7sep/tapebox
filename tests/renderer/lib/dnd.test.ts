// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useDragBodyCursor } from '@renderer/lib/dnd'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

function Probe() {
  const dragCursor = useDragBodyCursor()
  return createElement('button', { onClick: dragCursor.start }, 'Start drag')
}

function mountProbe(): void {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(createElement(Probe)))
}

function startDrag(): void {
  act(() => {
    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  expect(document.body.classList.contains('dnd-dragging')).toBe(true)
}

afterEach(() => {
  if (root !== null) act(() => root!.unmount())
  root = null
  document.body.classList.remove('dnd-dragging')
  document.body.innerHTML = ''
})

describe('useDragBodyCursor', () => {
  it('clears the window-wide cursor class when its owner unmounts', () => {
    mountProbe()
    startDrag()

    act(() => root!.unmount())
    root = null

    expect(document.body.classList.contains('dnd-dragging')).toBe(false)
  })

  it('clears the window-wide cursor class when the window loses context', () => {
    mountProbe()
    startDrag()

    act(() => window.dispatchEvent(new Event('blur')))

    expect(document.body.classList.contains('dnd-dragging')).toBe(false)
  })
})
