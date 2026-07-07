// Composition-aware keyboard handling for IME support.
//
// With an IME (Japanese, Chinese, Korean, …), pressing Enter confirms the
// candidate conversion rather than submitting. This hook tracks composition
// state so an Enter handler can tell "Enter to confirm the IME candidate" from
// "Enter to add / scan / commit", and skip the action while composing.
//
// Three-layer detection (all checked by isComposingKeyboardEvent):
//
//   1. compositionstart/compositionend set a ref flag. The compositionend
//      handler defers clearing by one animation frame: WebKit/Safari can fire
//      compositionend BEFORE the final Enter keydown, so without the delay the
//      flag would already be false when the keydown handler runs.
//   2. KeyboardEvent.isComposing — broadly supported in modern engines.
//   3. KeyboardEvent.keyCode === 229 — deprecated, but historically the most
//      reliable IME signal across older Blink and WebKit builds.

import { useCallback, useRef } from 'react'

interface ComposingHandlers {
  onCompositionStart: () => void
  onCompositionEnd: () => void
}

interface UseComposingReturn {
  composingRef: React.RefObject<boolean>
  handlers: ComposingHandlers
}

export function useComposing(): UseComposingReturn {
  const composingRef = useRef(false)
  const rafIdRef = useRef<number | null>(null)

  const onCompositionStart = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    composingRef.current = true
  }, [])

  const onCompositionEnd = useCallback(() => {
    rafIdRef.current = requestAnimationFrame(() => {
      composingRef.current = false
      rafIdRef.current = null
    })
  }, [])

  return { composingRef, handlers: { onCompositionStart, onCompositionEnd } }
}

export function isComposingKeyboardEvent(
  composingRef: React.RefObject<boolean>,
  e: React.KeyboardEvent | KeyboardEvent,
): boolean {
  if (composingRef.current) return true
  const nativeEvent = 'nativeEvent' in e ? e.nativeEvent : e
  if (nativeEvent.isComposing) return true

  // Legacy fallback for older IME implementations. keyCode is deprecated and may
  // eventually be dropped from TypeScript's DOM types; the cast keeps the build
  // working if so. Reading a missing property yields undefined rather than
  // throwing, so the guard simply degrades to the two checks above.
  const legacyKeyCode = (nativeEvent as { keyCode?: number }).keyCode
  if (legacyKeyCode === 229) return true

  return false
}
