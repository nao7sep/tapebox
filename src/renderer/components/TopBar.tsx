import { useState } from 'react'
import { ipcInvoke } from '@renderer/ipc/client'
import { useBinariesStore, allBinariesInstalled } from '@renderer/store/binaries'
import { useClipboardUrl } from '@renderer/lib/useClipboardUrl'
import { Button } from '@renderer/components/ui'

type Props = {
  /** Pause clipboard auto-fill (e.g. while the playlist modal owns the clipboard). */
  clipboardEnabled: boolean
}

/**
 * URL input bar for single items. Add queues immediately — no upfront probe;
 * the job probes as part of processing ("do"). The field auto-fills from the
 * clipboard via useClipboardUrl while the user hasn't typed over it.
 */
export function TopBar({ clipboardEnabled }: Props) {
  const { url, setUrl, onPaste, consume } = useClipboardUrl(clipboardEnabled)
  const [error, setError] = useState<string | null>(null)
  const toolsReady = useBinariesStore((s) => allBinariesInstalled(s.statuses))
  const openBinariesModal = useBinariesStore((s) => s.openModal)

  async function add(value: string) {
    const v = value.trim()
    if (!v || !toolsReady) return
    setError(null)
    try {
      await ipcInvoke('downloads:add', { url: v })
      consume()
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => { if (e.key === 'Enter') void add(url) }}
          placeholder="Paste a URL"
          spellCheck={false}
          className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm placeholder-zinc-500 focus:border-zinc-600 focus:outline-hidden"
        />
        <Button
          variant="primary"
          onClick={() => void add(url)}
          disabled={!url.trim() || !toolsReady}
        >
          Add
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
