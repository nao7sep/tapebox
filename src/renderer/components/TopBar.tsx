import { ipcInvoke } from '@renderer/ipc/client'
import { useBinariesStore, allBinariesInstalled } from '@renderer/store/binaries'
import { useToastStore } from '@renderer/store/toast'
import { useClipboardUrl } from '@renderer/lib/useClipboardUrl'
import { useComposing, isComposingKeyboardEvent } from '@renderer/lib/useComposing'
import { Button } from '@renderer/components/ui'

type Props = {
  /** Pause clipboard auto-fill (e.g. while the Scan-a-page modal owns the clipboard). */
  clipboardEnabled: boolean
}

/**
 * URL input bar for single tapes. Add queues immediately — no upfront probe;
 * the job probes as part of processing ("do"). The field auto-fills from the
 * clipboard via useClipboardUrl while the user hasn't typed over it.
 */
export function TopBar({ clipboardEnabled }: Props) {
  const { url, setUrl, onPaste, consume } = useClipboardUrl(clipboardEnabled)
  const { composingRef, handlers: composing } = useComposing()
  const toolsReady = useBinariesStore((s) => allBinariesInstalled(s.statuses))
  const openBinariesModal = useBinariesStore((s) => s.openModal)
  const notify = useToastStore((s) => s.notify)

  async function add(value: string) {
    const v = value.trim()
    if (!v || !toolsReady) return
    try {
      await ipcInvoke('downloads:add', { url: v })
      consume()
    } catch (err) {
      notify(String(err), 'error')
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
          onCompositionStart={composing.onCompositionStart}
          onCompositionEnd={composing.onCompositionEnd}
          onKeyDown={(e) => { if (e.key === 'Enter' && !isComposingKeyboardEvent(composingRef, e)) void add(url) }}
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
    </div>
  )
}
