import { useEffect, useState } from 'react'
import type { Tape } from '@shared/domain'
import { ipcInvoke } from '@renderer/ipc/client'
import { Modal } from '@renderer/components/Modal'
import { Button, Field, INPUT_CLASS } from '@renderer/components/ui'

type Props = {
  tape: Tape
  onClose: () => void
}

type Include = { title: boolean; uploader: boolean; description: boolean }

/**
 * Rename the on-disk media + sidecar to a slug. The AI button generates a
 * suggestion from the fields the user ticks (title / uploader / description) —
 * description is pulled from the sidecar and off by default since it's long and
 * noisy. Collisions / invalid slugs / missing AI config surface inline.
 */
export function RenameModal({ tape, onClose }: Props) {
  const [slug, setSlug] = useState(tape.slug ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'generate' | 'apply' | null>(null)
  const [description, setDescription] = useState<string | null>(null)
  const [include, setInclude] = useState<Include>({
    title: !!tape.title,
    uploader: !!tape.uploader,
    description: false,
  })

  // Pull the description from the sidecar so its checkbox can preview the value
  // and disable itself when there is none.
  useEffect(() => {
    let cancelled = false
    ipcInvoke('library:getSidecar', { tapeId: tape.id })
      .then((s) => {
        if (cancelled) return
        const d = (s as Record<string, unknown>)['description']
        setDescription(typeof d === 'string' && d.trim() ? d : null)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [tape.id])

  const available: Include = {
    title: !!tape.title,
    uploader: !!tape.uploader,
    description: !!description,
  }
  const canGenerate = include.title || include.uploader || include.description

  async function generate() {
    setError(null)
    setBusy('generate')
    try {
      const result = await ipcInvoke('ai:generateSlug', { tapeId: tape.id, include })
      setSlug(result.slug)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  async function apply() {
    setError(null)
    setBusy('apply')
    try {
      await ipcInvoke('library:renameToSlug', { tapeId: tape.id, slug })
      onClose()
    } catch (err) {
      setError(String(err))
      setBusy(null)
    }
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy !== null}>Cancel</Button>
      <Button
        variant="primary"
        onClick={() => void apply()}
        disabled={!slug.trim()}
        loading={busy === 'apply'}
      >
        {busy === 'apply' ? 'Renaming…' : 'Rename'}
      </Button>
    </>
  )

  return (
    <Modal title="Rename to slug" onClose={onClose} size="md" footer={footer} closeDisabled={busy !== null}>
      <p className="-mt-2 mb-4 truncate text-xs text-zinc-400">
        Current file: <span className="text-zinc-300">{tape.filename ?? '—'}</span>
      </p>

      <div className="space-y-4">
        <Field label="New slug">
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="lowercase-kebab-slug"
            spellCheck={false}
            disabled={busy !== null}
            className={`w-full ${INPUT_CLASS}`}
          />
        </Field>

        <Field label="Generate from">
          <div className="space-y-1.5">
            <IncludeRow
              label="Title"
              value={tape.title}
              checked={include.title}
              disabled={!available.title || busy !== null}
              onChange={(v) => setInclude((s) => ({ ...s, title: v }))}
            />
            <IncludeRow
              label="Uploader"
              value={tape.uploader}
              checked={include.uploader}
              disabled={!available.uploader || busy !== null}
              onChange={(v) => setInclude((s) => ({ ...s, uploader: v }))}
            />
            <IncludeRow
              label="Description"
              value={description}
              checked={include.description}
              disabled={!available.description || busy !== null}
              onChange={(v) => setInclude((s) => ({ ...s, description: v }))}
            />
          </div>
          <div className="mt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void generate()}
              disabled={busy !== null || !canGenerate}
              loading={busy === 'generate'}
            >
              {busy === 'generate' ? 'Generating…' : '✨ Generate with AI'}
            </Button>
          </div>
        </Field>
      </div>

      {error && (
        <p className="mt-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
      )}
    </Modal>
  )
}

/** A checkbox row that previews the field's value (or marks it unavailable). */
function IncludeRow({
  label,
  value,
  checked,
  disabled,
  onChange,
}: {
  label: string
  value: string | null
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className={'flex items-start gap-2 text-sm ' + (disabled ? 'opacity-50' : 'cursor-pointer')}>
      <input
        type="checkbox"
        className="mt-1 shrink-0"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="text-zinc-200">{label}</span>{' '}
        <span className="text-zinc-500">— {value && value.trim() ? truncate(value) : 'none'}</span>
      </span>
    </label>
  )
}

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}
