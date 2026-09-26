import { useId, useRef, useState } from 'react'
import { ipcInvoke } from '@renderer/ipc/client'
import { useBinariesStore, requiredBinariesUsable } from '@renderer/store/binaries'
import { useClipboardUrl } from '@renderer/lib/useClipboardUrl'
import { useComposing, isComposingKeyboardEvent } from '@renderer/lib/useComposing'
import { presentFailure } from '@renderer/lib/presentFailure'
import { Button, InlineError } from '@renderer/components/ui'
import { useI18n } from '@renderer/i18n/I18nContext'
import { message, type Message } from '@shared/i18n/translate'

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
  const t = useI18n()
  const { url, setUrl, onPaste, consume } = useClipboardUrl(clipboardEnabled)
  const { composingRef, handlers: composing } = useComposing()
  // Gates Add only — missing tools surface exclusively through the status bar's
  // permanent roll-up (amber, click-through) and the first-run modal, never as an
  // inline banner here: a conditional message under this row grows the top bar
  // and shifts the layout the moment the state it guards first occurs.
  const toolsReady = useBinariesStore((s) => requiredBinariesUsable(s.statuses))
  const [error, setError] = useState<Message | null>(null)
  // One Add at a time: a double click or a repeated Enter must not send the URL twice.
  const addingRef = useRef(false)
  const [adding, setAdding] = useState(false)
  const errorId = useId()

  async function add(value: string) {
    const v = value.trim()
    if (!v || !toolsReady || addingRef.current) return
    addingRef.current = true
    setAdding(true)
    try {
      await ipcInvoke('downloads:add', { url: v })
      setError(null)
      consume()
    } catch (err) {
      setError(presentFailure(err, message('topBar.addFailed'), 'add URL failed'))
    } finally {
      addingRef.current = false
      setAdding(false)
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
          placeholder={t.t('topBar.placeholder')}
          spellCheck={false}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? errorId : undefined}
          className="h-9 flex-1 rounded border border-field-line bg-panel px-3 text-sm placeholder-fg-subtle focus:border-field-focus focus:outline-hidden"
        />
        <Button
          variant="primary"
          onClick={() => void add(url)}
          disabled={!url.trim() || !toolsReady || adding}
        >
          {t.t('topBar.add')}
        </Button>
      </div>
      {error && (
        <InlineError id={errorId} onDismiss={() => setError(null)} closeLabel={t.t('topBar.closeResult')}>
          {t.text(error)}
        </InlineError>
      )}
    </div>
  )
}
