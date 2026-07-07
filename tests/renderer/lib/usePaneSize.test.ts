// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { usePaneSize } from '@renderer/lib/usePaneSize'
import { clampSplitter } from '@shared/layout'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom computes no layout and ships no ResizeObserver. Stub a minimal RO that
// fires once on observe, and drive container size by stubbing clientWidth — so
// the hook's derivation (intent → clampSplitter against the live container) runs
// the real path. We change the stubbed size and force a re-measure to model a
// window resize.
let measureCbs: Array<() => void> = []
class FakeResizeObserver {
  constructor(private cb: () => void) {}
  observe() {
    measureCbs.push(this.cb)
    this.cb()
  }
  disconnect() {}
}

let root: Root | null = null
let host: HTMLDivElement
let captured: { containerRef: { current: HTMLElement | null }; displayed: number }

const OPTS = { siblingMin: 360, min: 200, max: 720 }

function Probe({ intent, width }: { intent: number; width: number }) {
  const result = usePaneSize<HTMLDivElement>(intent, false, OPTS)
  captured = result
  // Attach the ref to a div whose clientWidth we control.
  const setRef = (el: HTMLDivElement | null) => {
    ;(result.containerRef as { current: HTMLDivElement | null }).current = el
    if (el) Object.defineProperty(el, 'clientWidth', { value: width, configurable: true })
  }
  return React.createElement('div', { ref: setRef })
}

function render(intent: number, width: number) {
  act(() => {
    root!.render(React.createElement(Probe, { intent, width }))
  })
  // Flush the effect-registered observer's first measure.
  act(() => {
    for (const cb of measureCbs) cb()
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  measureCbs = []
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  document.body.innerHTML = ''
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

describe('usePaneSize intent → display derivation', () => {
  it('derives the displayed size by clamping the intent to the live container', () => {
    const intent = 500
    render(intent, 1000)
    // Plenty of room (1000 − 360 = 640 ceiling): the intent shows in full.
    expect(captured.displayed).toBe(clampSplitter(intent, { available: 1000, ...OPTS }))
    expect(captured.displayed).toBe(500)
  })

  it('a small container narrows the DISPLAY without changing the intent it derives from', () => {
    const intent = 700
    // Small window: ceiling is 600 − 360 = 240, below the 700 intent → display
    // narrows to 240. The intent passed in is untouched; nothing here persists.
    render(intent, 600)
    expect(captured.displayed).toBe(240)
    expect(captured.displayed).toBeLessThan(intent)

    // Grow the window back: the SAME intent now shows in full again — proof the
    // clamp was display-only and the intent was never mutated by the shrink.
    render(intent, 2000)
    expect(captured.displayed).toBe(intent)
  })
})
