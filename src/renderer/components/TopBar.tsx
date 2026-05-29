import { useEffect, useRef, useState } from 'react'
import { ipcInvoke } from '@renderer/ipc/client'
import { useEnumerationStore } from '@renderer/store/enumeration'
import { useBinariesStore, allBinariesInstalled } from '@renderer/store/binaries'
import { Button } from '@renderer/components/ui'

const URL_PATTERN = /^https?:\/\//i
const CLIPBOARD_POLL_MS = 1500

/**
 * URL input bar with clipboard auto-fill.
 *
 * `autoFilledRef` tracks the last clipboard-sourced URL in the field — whether
 * we auto-filled it OR the user pasted it (recorded via onPaste) — or the last
 * submitted URL. A pasted URL is clipboard content, same as an auto-fill; only
 * a *typed* URL counts as user input. It plays two roles at once:
 *
 *   1. "Have we already processed this clipboard value?" — if clipboard text
 *      equals autoFilledRef, we don't re-fill (covers don't-loop and
 *      don't-reappear-after-submit).
 *   2. "Is the current field value still clipboard-sourced?" — if field equals
 *      autoFilledRef, the user hasn't typed over it, so we can replace it when
 *      the clipboard changes to a new URL. If field is non-empty and differs
 *      from autoFilledRef, it's typed input and we never overwrite it.
 *
 * Polled every CLIPBOARD_POLL_MS, on window focus, and once on mount.
 *
 * Submit goes through enum:detect to learn the URL's shape:
 *   - 'single' → downloads:add directly
 *   - 'multi'  → open the playlist modal, which owns enum:start
 */
export function TopBar() {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const openEnum = useEnumerationStore((s) => s.open)
  const toolsReady = useBinariesStore((s) => allBinariesInstalled(s.statuses))
  const openBinariesModal = useBinariesStore((s) => s.openModal)

  const urlRef = useRef(url)
  urlRef.current = url
  const autoFilledRef = useRef<string>('')

  useEffect(() => {
    async function syncFromClipboard() {
      let text: string
      try {
        text = (await navigator.clipboard.readText()).trim()
      } catch {
        return // permission denied / empty / non-text
      }
      // Trim the field for comparison: text inputs strip newlines on paste, so a
      // pasted "url\n" lands as "url" while autoFilledRef holds the trimmed form.
      const field = urlRef.current.trim()
      // The field is typed input once it holds anything other than our last
      // clipboard-sourced value.
      const owned = field !== '' && field !== autoFilledRef.current
      // Fill only a fresh URL (clipboard moved past our last value) into a field
      // the user hasn't typed over.
      if (URL_PATTERN.test(text) && text !== autoFilledRef.current && !owned) {
        setUrl(text)
        autoFilledRef.current = text
      }
    }
    void syncFromClipboard()
    window.addEventListener('focus', syncFromClipboard)
    const id = setInterval(syncFromClipboard, CLIPBOARD_POLL_MS)
    return () => {
      window.removeEventListener('focus', syncFromClipboard)
      clearInterval(id)
    }
  }, [])

  async function add(value: string) {
    const v = value.trim()
    if (!v || !toolsReady) return
    setBusy(true)
    setError(null)
    try {
      const result = await ipcInvoke('enum:detect', { url: v })
      if (result.kind === 'single') {
        await ipcInvoke('downloads:add', { url: v })
      } else {
        openEnum(v, result.sourceTitle)
      }
      setUrl('')
      // Suppress the submitted URL from reappearing while it's still on the
      // clipboard. Cleared implicitly when the clipboard moves to anything else.
      autoFilledRef.current = v
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={(e) => {
            // A pasted URL is clipboard content, not typed input — record it so a
            // later copy can still replace it (same treatment as an auto-fill).
            const pasted = e.clipboardData.getData('text').trim()
            if (URL_PATTERN.test(pasted)) autoFilledRef.current = pasted
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') void add(url) }}
          placeholder="Paste a URL"
          spellCheck={false}
          className="flex-1 rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm placeholder-zinc-600 focus:border-zinc-600 focus:outline-hidden"
        />
        <Button
          variant="primary"
          onClick={() => void add(url)}
          disabled={busy || !url.trim() || !toolsReady}
        >
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>

      {!toolsReady && (
        <p className="text-xs text-amber-300">
          Downloading needs yt-dlp and its helpers.{' '}
          <button
            onClick={() => openBinariesModal()}
            className="underline hover:text-amber-200"
          >
            Install tools
          </button>
        </p>
      )}

      {error && (
        <p className="rounded border border-red-900 bg-red-950/40 px-3 py-1.5 text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  )
}
