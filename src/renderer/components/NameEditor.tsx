import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Tape } from '@shared/domain'
import { ipcInvoke } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import { Button, Field, INPUT_LINE_CLASS } from '@renderer/components/ui'
import { presentFailure } from '@renderer/lib/presentFailure'
import { PassiveScrollRegion } from './PassiveScrollRegion'

/** The source fields an AI name suggestion can draw on. */
type SourceField = 'title' | 'uploader' | 'description'

const SOURCE_FIELDS: { key: SourceField; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'uploader', label: 'Uploader' },
  { key: 'description', label: 'Description' },
]

/**
 * Shared filename editor used by both Rename and Export. A name field plus an AI
 * "suggest" path that builds a slug from the source fields the user ticks. The
 * value is controlled by the parent so each modal applies it however it wants:
 * Rename re-stems the files in place, Export names the copied-out files.
 *
 * Any filesystem-safe name is allowed — the AI only suggests a slug the user can
 * accept or edit. Generating is reported up via onGeneratingChange so the parent
 * can disable its own primary action; generate errors surface here. A running
 * suggestion can be stopped with its own button, and unmounting (closing the
 * dialog) stops it too, so a slow provider never holds the dialog open.
 */
export function NameEditor({
  tape,
  value,
  onChange,
  disabled = false,
  onGeneratingChange,
  label = 'Name',
  placeholder = 'file-name',
  hint,
}: {
  tape: Tape
  value: string
  onChange: (v: string) => void
  /** Parent is applying — disable the editor while it runs. */
  disabled?: boolean
  onGeneratingChange?: (generating: boolean) => void
  label?: string
  placeholder?: string
  /** Optional note shown right under the name input (e.g. what the name applies to). */
  hint?: ReactNode
}) {
  const [generating, setGenerating] = useState(false)
  // The in-flight suggestion's id, so Stop and unmount can cancel exactly it.
  const requestRef = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [description, setDescription] = useState<string | null>(null)
  const [include, setInclude] = useState<Record<SourceField, boolean>>({
    title: !!tape.title,
    uploader: !!tape.uploader,
    description: false,
  })

  // Pull the description from the sidecar so its row can preview the value and tick
  // on once available (title/uploader are already on the tape, so they tick on
  // synchronously above).
  useEffect(() => {
    let cancelled = false
    ipcInvoke('library:getSidecar', { tapeId: tape.id })
      .then((s) => {
        if (cancelled) return
        const d = (s as Record<string, unknown>)['description']
        const desc = typeof d === 'string' && d.trim() ? d : null
        setDescription(desc)
        if (desc) setInclude((prev) => ({ ...prev, description: true }))
      })
      .catch((err) => log.debug('sidecar preview load failed', { tapeId: tape.id, error: describeError(err) }))
    return () => { cancelled = true }
  }, [tape.id])

  const sourceValue: Record<SourceField, string | null> = {
    title: tape.title,
    uploader: tape.uploader,
    description,
  }
  // Closing the dialog mid-suggestion cancels the request in main.
  useEffect(() => () => {
    const requestId = requestRef.current
    requestRef.current = null
    if (requestId) cancelSuggestion(requestId)
  }, [])

  const canSuggest = include.title || include.uploader || include.description
  const busy = disabled || generating
  // A field with no value contributes nothing, so it's dropped from the list
  // entirely rather than shown as an empty "none" row.
  const availableFields = SOURCE_FIELDS.filter(({ key }) => !!sourceValue[key]?.trim())

  async function suggest() {
    const requestId = crypto.randomUUID()
    requestRef.current = requestId
    setError(null)
    setGenerating(true)
    onGeneratingChange?.(true)
    try {
      const result = await ipcInvoke('ai:generateSlug', { tapeId: tape.id, include, requestId })
      if (requestRef.current === requestId) onChange(result.slug)
    } catch (err) {
      // A stopped or abandoned request is the user's choice, not a failure.
      if (requestRef.current === requestId) {
        setError(presentFailure(err, 'A name could not be suggested. Check the AI settings and try again.', 'AI name suggestion failed'))
      }
    } finally {
      if (requestRef.current === requestId) {
        requestRef.current = null
        setGenerating(false)
        onGeneratingChange?.(false)
      }
    }
  }

  function stop() {
    const requestId = requestRef.current
    if (!requestId) return
    requestRef.current = null
    cancelSuggestion(requestId)
    setGenerating(false)
    onGeneratingChange?.(false)
  }

  return (
    <div className="space-y-4">
      <div>
        <Field label={label}>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            disabled={busy}
            className={`w-full ${INPUT_LINE_CLASS}`}
          />
        </Field>
        {hint && <p className="mt-1.5 text-xs text-fg-muted">{hint}</p>}
      </div>

      {availableFields.length > 0 && (
        <div>
          {/* Header row mirrors the Site profiles header: section label left, action
              right. The button reads naturally next to "Suggest with AI from …". */}
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-fg">Suggest with AI from</div>
            {generating ? (
              <Button variant="secondary" size="sm" onClick={stop}>
                Stop
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void suggest()}
                disabled={busy || !canSuggest}
              >
                Suggest
              </Button>
            )}
          </div>

          {/* Definition list: a ticked field feeds the suggestion. Label and value
              sit in their own columns (no hyphen joining them); values aren't
              truncated, and the long description scrolls inside a read-only box. */}
          <dl className="mt-2 grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-2 text-sm">
            {availableFields.map(({ key, label: fieldLabel }) => (
              <SourceRow
                key={key}
                label={fieldLabel}
                value={sourceValue[key]!}
                checked={include[key]}
                disabled={busy}
                scrollable={key === 'description'}
                onChange={(v) => setInclude((s) => ({ ...s, [key]: v }))}
              />
            ))}
          </dl>
        </div>
      )}

      {error && (
        <p className="rounded border border-danger-line bg-danger-tint px-3 py-2 text-xs text-danger-fg">{error}</p>
      )}
    </div>
  )
}

function cancelSuggestion(requestId: string): void {
  void ipcInvoke('ai:cancelSlug', { requestId })
    .catch((err) => log.debug('AI suggestion cancel failed', { error: describeError(err) }))
}

/**
 * One source field as a `dt` (a checkbox + label that toggles inclusion) and a
 * `dd` (the full value). The checkbox aligns to its label line via items-center.
 * The long description sits in a read-only scrollable box that carries the modal's
 * own background — it isn't an input, so it doesn't wear the darker input fill.
 */
function SourceRow({
  label,
  value,
  checked,
  disabled,
  scrollable,
  onChange,
}: {
  label: string
  value: string
  checked: boolean
  disabled?: boolean
  scrollable?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <>
      <dt>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
          <span className="text-fg">{label}</span>
        </label>
      </dt>
      <dd className="min-w-0">
        {scrollable ? (
          <PassiveScrollRegion
            label={`${label} source value`}
            className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded border border-line-subtle p-2 text-xs text-fg"
          >
            {value}
          </PassiveScrollRegion>
        ) : (
          <span className="select-text break-words text-fg-emphasis">{value}</span>
        )}
      </dd>
    </>
  )
}
