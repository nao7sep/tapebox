import { useState } from 'react'
import type { Tape } from '@shared/domain'
import { Modal } from '@renderer/components/Modal'
import { NameEditor } from '@renderer/components/NameEditor'
import { Button, InlineError } from '@renderer/components/ui'
import { presentFailure } from '@renderer/lib/presentFailure'

type Props = {
  tape: Tape
  /** Performs the rename. The parent owns it so it can pause and restore the
   *  player around the file swap (the video keeps playing while you edit here). */
  onRename: (name: string) => Promise<void>
  onClose: () => void
}

/**
 * Rename the on-disk media + sidecar + thumbnail to a user-chosen name — any
 * filesystem-safe name, or an AI-suggested slug (the shared NameEditor handles
 * the field and the suggestion). Collisions / invalid names / missing AI config
 * surface inline. The actual file operation is delegated to onRename so the
 * caller can keep playback going and seek back afterwards.
 */
export function RenameModal({ tape, onRename, onClose }: Props) {
  const [name, setName] = useState(tape.name ?? '')
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [generating, setGenerating] = useState(false)

  async function apply() {
    setError(null)
    setApplying(true)
    try {
      await onRename(name)
      onClose()
    } catch (err) {
      setError(presentFailure(err, 'The tape could not be renamed. Existing filenames are unchanged; try another name or close apps using the files.', 'tape rename failed'))
      setApplying(false)
    }
  }

  const busy = applying || generating
  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button
        variant="primary"
        onClick={() => void apply()}
        disabled={!name.trim() || busy}
        loading={applying}
      >
        {applying ? 'Renaming…' : 'Rename'}
      </Button>
    </>
  )

  return (
    <Modal title="Rename" onClose={onClose} size="2xl" footer={footer} closeDisabled={busy}>
      <div className="mb-4">
        <div className="text-xs text-zinc-400">Current name</div>
        <div className="mt-1 truncate text-base text-zinc-200">{tape.filename ?? '—'}</div>
      </div>

      <NameEditor
        tape={tape}
        value={name}
        onChange={setName}
        disabled={applying}
        onGeneratingChange={setGenerating}
        label="New name"
      />

      {error && <InlineError className="mt-4">{error}</InlineError>}
    </Modal>
  )
}
