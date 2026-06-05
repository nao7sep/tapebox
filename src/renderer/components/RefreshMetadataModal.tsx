import { useState } from 'react'
import type { Tape } from '@shared/domain'
import type { RefreshedMetadata } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import { useToastStore } from '@renderer/store/toast'
import { formatTime } from '@renderer/lib/format'
import { Modal } from './Modal'
import { Button, Spinner } from './ui'

/**
 * Review-then-apply metadata refresh, and a rarely-needed one: saved metadata is
 * almost always fine, so the modal opens showing only the current values with the
 * "New" column deliberately empty — it makes no network call until the user asks.
 * "Check source" re-probes and fills the New column beside each current value, so
 * a refresh that comes back empty (a site that now blocks, a changed page) can't
 * silently overwrite good data — the user sees it and cancels. Apply persists
 * exactly what's shown.
 */
export function RefreshMetadataModal({ tape, onClose }: { tape: Tape; onClose: () => void }) {
  const [candidate, setCandidate] = useState<RefreshedMetadata | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const [applying, setApplying] = useState(false)
  const notify = useToastStore((s) => s.notify)

  const probed = candidate !== null

  async function checkSource() {
    setProbing(true)
    setError(null)
    try {
      setCandidate(await ipcInvoke('library:probeMetadata', { tapeId: tape.id }))
    } catch (err) {
      setError(String(err))
    } finally {
      setProbing(false)
    }
  }

  async function apply() {
    if (!candidate) return
    setApplying(true)
    setError(null)
    try {
      await ipcInvoke('library:applyMetadata', { tapeId: tape.id, metadata: candidate })
      notify('Metadata updated.', 'info')
      onClose()
    } catch (err) {
      setError(String(err))
      setApplying(false)
    }
  }

  // The primary action is always the natural next step: check the source until
  // there's something to review, then apply it. Re-checking stays available as a
  // secondary once a candidate is in hand.
  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={applying}>Cancel</Button>
      {probed && (
        <Button variant="secondary" onClick={() => void checkSource()} loading={probing} disabled={applying}>
          Check again
        </Button>
      )}
      {probed ? (
        <Button variant="primary" onClick={() => void apply()} loading={applying}>
          {applying ? 'Applying…' : 'Apply'}
        </Button>
      ) : (
        <Button variant="primary" onClick={() => void checkSource()} loading={probing}>
          Check source
        </Button>
      )}
    </>
  )

  return (
    <Modal title="Refresh metadata" onClose={onClose} size="2xl" footer={footer} closeDisabled={applying} fitContent>
      <div className="space-y-2">
        <p className="mb-3 text-xs text-zinc-400">
          {probed
            ? 'Nothing changes unless you apply. A value shown in amber would replace existing data with nothing — cancel if that isn’t what you want.'
            : 'Your saved metadata is shown below. It’s almost always fine — check the source only if you have reason to think the page now has better data. Nothing is fetched or changed until you do.'}
        </p>
        {error && (
          <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
        )}
        <div className="grid grid-cols-[6rem_1fr_1fr] gap-x-3 text-xs font-medium text-zinc-500">
          <div />
          <div>Current</div>
          <div className="flex items-center gap-2">New {probing && <Spinner />}</div>
        </div>
        <FieldDiff label="Title" probed={probed} current={nv(tape.title)} next={nv(candidate?.title ?? null)} />
        <FieldDiff label="Uploader" probed={probed} current={nv(tape.uploader)} next={nv(candidate?.uploader ?? null)} />
        <FieldDiff
          label="Duration"
          probed={probed}
          current={tape.durationSeconds != null ? formatTime(tape.durationSeconds) : null}
          next={candidate?.durationSeconds != null ? formatTime(candidate.durationSeconds) : null}
        />
        <FieldDiff
          label="Chapters"
          probed={probed}
          current={tape.chapterCount != null ? String(tape.chapterCount) : null}
          next={candidate?.chapterCount != null ? String(candidate.chapterCount) : null}
        />
      </div>
    </Modal>
  )
}

/** Trim a string to null when it's blank, so "" reads as "no value". */
function nv(s: string | null): string | null {
  return s && s.trim() ? s : null
}

function FieldDiff({
  label,
  current,
  next,
  probed,
}: {
  label: string
  current: string | null
  next: string | null
  /** Until the source has been checked, the New column is blank by design — not a
   *  data-loss warning — so the amber/changed cues only apply once probed. */
  probed: boolean
}) {
  const losing = probed && current !== null && next === null // had data, refresh returns none
  const changed = probed && (current ?? '') !== (next ?? '')
  return (
    <div className="grid grid-cols-[6rem_1fr_1fr] items-start gap-x-3 gap-y-0.5 py-1 text-xs">
      <div className="pt-0.5 text-zinc-500">{label}</div>
      <div className="min-w-0 break-words text-zinc-400">{current ?? '—'}</div>
      <div
        className={
          'min-w-0 break-words ' +
          (losing ? 'text-amber-300' : changed ? 'text-zinc-100' : 'text-zinc-400')
        }
      >
        {next ?? '—'}
      </div>
    </div>
  )
}
