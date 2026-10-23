import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import { isImportableUrl } from '@shared/url'

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
 * bar pauses while the Scan-a-page modal (which has its own field) is open.
 *
 * `initial` seeds the field (e.g. the Scan-a-page modal opened from a listing tape's URL).
 * A non-empty seed reads as user-owned, so the clipboard won't overwrite it.
 */
export function useClipboardUrl(enabled: boolean, initial = '') {
  const [url, setUrl] = useState(initial)
  const urlRef = useRef(url)
  urlRef.current = url
  const autoFilledRef = useRef('')

  useEffect(() => {
    if (!enabled) return
    let alive = true
    let focused = false
    let generation = 0
    let reading = false
    let interval: ReturnType<typeof setInterval> | null = null
    const userOwned = () => {
      const field = urlRef.current.trim()
      return field !== '' && field !== autoFilledRef.current
    }
    async function sync() {
      if (!alive || !focused || reading || userOwned()) return
      const started = generation
      reading = true
      try {
        const text = (await navigator.clipboard.readText()).trim()
        // The read can settle after blur, disable, unmount or a user edit.
        if (!alive || !focused || started !== generation || userOwned()) return
        if (isImportableUrl(text) && text !== autoFilledRef.current) {
          setUrl(text)
          autoFilledRef.current = text
        }
      } catch {
        // Permission denied / empty / non-text clipboard.
      } finally {
        if (started === generation) reading = false
      }
    }
    function pause() {
      focused = false
      generation += 1
      reading = false
      if (interval !== null) clearInterval(interval)
      interval = null
    }
    function resume() {
      pause()
      focused = true
      void sync()
      interval = setInterval(sync, CLIPBOARD_POLL_MS)
    }
    if (document.hasFocus()) resume()
    window.addEventListener('focus', resume)
    window.addEventListener('blur', pause)
    return () => {
      alive = false
      pause()
      window.removeEventListener('focus', resume)
      window.removeEventListener('blur', pause)
    }
  }, [enabled])

  function onPaste(e: ClipboardEvent) {
    const pasted = e.clipboardData.getData('text').trim()
    if (isImportableUrl(pasted)) autoFilledRef.current = pasted
  }

  /** Clear the field after using `sent`, suppressing its immediate re-fill. A URL
   *  typed while `sent` was being added stays: it is the user's newer input. */
  function consume(sent: string) {
    autoFilledRef.current = sent
    if (urlRef.current.trim() === sent) setUrl('')
  }

  return { url, setUrl, onPaste, consume }
}
