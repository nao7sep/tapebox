import { useEffect, useRef, useState, type ClipboardEvent } from 'react'

const URL_PATTERN = /^https?:\/\//i
const CLIPBOARD_POLL_MS = 1500

/**
 * A URL text field that mirrors the clipboard while the user hasn't typed over
 * it.
 *
 * `autoFilledRef` is the last clipboard-sourced URL in the field — auto-filled
 * OR pasted (recorded via onPaste) — or the last consumed value. It serves two
 * roles: an "already processed" marker (don't re-fill the same clipboard URL)
 * and an "is the field still clipboard-sourced?" reference (vs typed input).
 * A pasted URL counts as clipboard content, same as an auto-fill; only a typed
 * URL is user input.
 *
 * `enabled` gates polling so only one field auto-fills at a time — e.g. the main
 * bar pauses while the Add-from-a-page modal (which has its own field) is open.
 *
 * `initial` seeds the field (e.g. the page scan seeded from a page tape).
 * A non-empty seed reads as user-owned, so the clipboard won't overwrite it.
 */
export function useClipboardUrl(enabled: boolean, initial = '') {
  const [url, setUrl] = useState(initial)
  const urlRef = useRef(url)
  urlRef.current = url
  const autoFilledRef = useRef('')

  useEffect(() => {
    if (!enabled) return
    async function sync() {
      let text: string
      try {
        text = (await navigator.clipboard.readText()).trim()
      } catch {
        return // permission denied / empty / non-text
      }
      const field = urlRef.current.trim()
      const owned = field !== '' && field !== autoFilledRef.current
      if (URL_PATTERN.test(text) && text !== autoFilledRef.current && !owned) {
        setUrl(text)
        autoFilledRef.current = text
      }
    }
    void sync()
    window.addEventListener('focus', sync)
    const id = setInterval(sync, CLIPBOARD_POLL_MS)
    return () => {
      window.removeEventListener('focus', sync)
      clearInterval(id)
    }
  }, [enabled])

  function onPaste(e: ClipboardEvent) {
    const pasted = e.clipboardData.getData('text').trim()
    if (URL_PATTERN.test(pasted)) autoFilledRef.current = pasted
  }

  /** Clear the field after using its value, suppressing immediate re-fill. */
  function consume() {
    autoFilledRef.current = urlRef.current.trim()
    setUrl('')
  }

  return { url, setUrl, onPaste, consume }
}
