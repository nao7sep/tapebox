import { useEffect, useState } from 'react'
import { ipcInvoke } from '@renderer/ipc/client'
import { useEnumerationStore } from '@renderer/store/enumeration'
import { useBinariesStore, allBinariesInstalled } from '@renderer/store/binaries'

const URL_PATTERN = /^https?:\/\//i

/**
 * URL input bar.
 *   - On window focus, inspects the clipboard and offers any http(s) URL.
 *   - Submitting calls enum:detect to learn the URL's shape:
 *       - 'single' → downloads:add directly
 *       - 'multi'  → open the playlist modal, which owns enum:start
 */
export function TopBar() {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const openEnum = useEnumerationStore((s) => s.open)
  const toolsReady = useBinariesStore((s) => allBinariesInstalled(s.statuses))
  const openBinariesModal = useBinariesStore((s) => s.openModal)

  useEffect(() => {
    const onFocus = async () => {
      try {
        const text = (await navigator.clipboard.readText()).trim()
        if (URL_PATTERN.test(text) && text !== url) setSuggestion(text)
      } catch {
        // Clipboard may be empty or read denied; ignore.
      }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [url])

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
      setSuggestion(null)
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
          onKeyDown={(e) => { if (e.key === 'Enter') void add(url) }}
          placeholder="Paste a URL"
          spellCheck={false}
          className="flex-1 rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm placeholder-zinc-600 focus:border-zinc-600 focus:outline-hidden"
        />
        <button
          onClick={() => void add(url)}
          disabled={busy || !url.trim() || !toolsReady}
          className="rounded bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-950 disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
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

      {suggestion && (
        <button
          onClick={() => { setUrl(suggestion); setSuggestion(null) }}
          className="text-xs text-zinc-400 hover:text-zinc-200"
        >
          Use clipboard: <span className="text-zinc-300">{suggestion}</span>
        </button>
      )}

      {error && (
        <p className="rounded border border-red-900 bg-red-950/40 px-3 py-1.5 text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  )
}
