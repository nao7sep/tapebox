import { useId, useState } from 'react'
import { ipcInvoke } from '@renderer/ipc/client'
import { useBinariesStore, requiredBinariesUsable } from '@renderer/store/binaries'
import { useClipboardUrl } from '@renderer/lib/useClipboardUrl'
import { useComposing, isComposingKeyboardEvent } from '@renderer/lib/useComposing'
import { errorMessage } from '@shared/error'
import { Button, InlineError } from '@renderer/components/ui'

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
  // Gates Add only — missing tools surface exclusively through the status bar's
  // permanent roll-up (amber, click-through) and the first-run modal, never as an
  // inline banner here: a conditional message under this row grows the top bar
  // and shifts the layout the moment the state it guards first occurs.
  const toolsReady = useBinariesStore((s) => requiredBinariesUsable(s.statuses))
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()

  async function add(value: string) {
    const v = value.trim()
    if (!v || !toolsReady) return
    try {
      await ipcInvoke('downloads:add', { url: v })
      setError(null)
      consume()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            setError(null)
          }}
          onPaste={onPaste}
          onCompositionStart={composing.onCompositionStart}
          onCompositionEnd={composing.onCompositionEnd}
          onKeyDown={(e) => { if (e.key === 'Enter' && !isComposingKeyboardEvent(composingRef, e)) void add(url) }}
          placeholder="Paste a URL"
          spellCheck={false}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? errorId : undefined}
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
      {error && (
        <InlineError id={errorId} onDismiss={() => setError(null)} dismissLabel="Dismiss Add URL error">
          {error}
        </InlineError>
      )}
    </div>
  )
}
