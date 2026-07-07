// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { useComposing, isComposingKeyboardEvent } from '@renderer/lib/useComposing'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Composing = ReturnType<typeof useComposing>

let root: Root | null = null
let captured: Composing | null = null

// useComposing relies on useRef/useCallback, so it must run inside a render. A
// throwaway component captures its return value; the refs and handlers it hands
// back are stable, so the test can drive composition directly afterward.
function Harness(): null {
  captured = useComposing()
  return null
}

async function mountHarness(): Promise<Composing> {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(React.createElement(Harness))
  })
  if (captured === null) {
    throw new Error('useComposing did not render')
  }
  return captured
}

// A bare Enter keydown: not composing, keyCode 13. Overrides model the IME/legacy
// signals isComposingKeyboardEvent inspects on the native event.
function enterEvent(over: { isComposing?: boolean; keyCode?: number } = {}): React.KeyboardEvent {
  return { nativeEvent: { isComposing: false, keyCode: 13, ...over } } as unknown as React.KeyboardEvent
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      root?.unmount()
    })
    root = null
  }
  captured = null
  document.body.innerHTML = ''
})

describe('isComposingKeyboardEvent', () => {
  it('reports not composing for a plain Enter (keyCode 13, not composing)', async () => {
    const { composingRef } = await mountHarness()
    expect(isComposingKeyboardEvent(composingRef, enterEvent())).toBe(false)
  })

  it('treats KeyboardEvent.isComposing as composing', async () => {
    const { composingRef } = await mountHarness()
    expect(isComposingKeyboardEvent(composingRef, enterEvent({ isComposing: true }))).toBe(true)
  })

  it('treats the legacy keyCode 229 as composing even without composition events', async () => {
    const { composingRef } = await mountHarness()
    expect(isComposingKeyboardEvent(composingRef, enterEvent({ keyCode: 229 }))).toBe(true)
  })
})

describe('useComposing lifecycle', () => {
  it('holds composing across compositionend until the next frame (WebKit late keydown)', async () => {
    const { composingRef, handlers } = await mountHarness()

    handlers.onCompositionStart()
    expect(isComposingKeyboardEvent(composingRef, enterEvent())).toBe(true)

    handlers.onCompositionEnd()
    // WebKit/Safari fires compositionend BEFORE the Enter keydown that confirms
    // the candidate, so an Enter arriving now — the clear still pending — must
    // still read as composing and therefore not submit.
    expect(isComposingKeyboardEvent(composingRef, enterEvent())).toBe(true)

    await act(async () => {
      await nextFrame()
    })
    expect(isComposingKeyboardEvent(composingRef, enterEvent())).toBe(false)
  })

  it('cancels a pending clear when composition restarts before the frame', async () => {
    const { composingRef, handlers } = await mountHarness()

    handlers.onCompositionStart()
    handlers.onCompositionEnd() // schedule the clear...
    handlers.onCompositionStart() // ...but start a new composition first

    await act(async () => {
      await nextFrame()
    })

    // The stale clear must have been cancelled; we are still composing.
    expect(isComposingKeyboardEvent(composingRef, enterEvent())).toBe(true)
  })
})
