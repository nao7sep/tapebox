import { useEffect, useState } from 'react'
import type { Tape } from '@shared/domain'
import type { RefreshedMetadata } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import { useToastStore } from '@renderer/store/toast'
import { formatTime } from '@renderer/lib/format'
import { Modal } from './Modal'
import { Button, Spinner } from './ui'

/**
 * Review-then-apply metadata refresh. Re-probes the source on open and shows the
 * candidate beside the current value field by field, so a refresh that comes
 * back empty (a site that now blocks, a changed page) can't silently overwrite
 * good data — the user sees it and cancels. Apply persists exactly what's shown.
 */
export function RefreshMetadataModal({ tape, onClose }: { tape: Tape; onClose: () => void }) {
  const [candidate, setCandidate] = useState<RefreshedMetadata | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const notify = useToastStore((s) => s.notify)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ipcInvoke('library:probeMetadata', { tapeId: tape.id })
      .then((c) => { if (!cancelled) setCandidate(c) })
      .catch((err) => { if (!cancelled) setError(String(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tape.id])

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

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={applying}>Cancel</Button>
      <Button
        variant="primary"
        onClick={() => void apply()}
        disabled={loading || !candidate}
        loading={applying}
      >
        {applying ? 'Applying…' : 'Apply'}
      </Button>
    </>
  )

  return (
    <Modal title="Refresh metadata" onClose={onClose} size="2xl" footer={footer} closeDisabled={applying} fitContent>
      {loading ? (
        <p className="flex items-center gap-2 text-sm text-zinc-300">
          <Spinner /> Re-probing the source…
        </p>
      ) : error ? (
        <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
      ) : candidate ? (
        <div className="space-y-2">
          <p className="mb-3 text-xs text-zinc-400">
            Nothing changes unless you apply. A value shown in amber would replace
            existing data with nothing — cancel if that isn’t what you want.
          </p>
          <div className="grid grid-cols-[6rem_1fr_1fr] gap-x-3 text-xs font-medium text-zinc-500">
            <div />
            <div>Current</div>
            <div>New</div>
          </div>
          <FieldDiff label="Title" current={nv(tape.title)} next={nv(candidate.title)} />
          <FieldDiff label="Uploader" current={nv(tape.uploader)} next={nv(candidate.uploader)} />
          <FieldDiff
            label="Duration"
            current={tape.durationSeconds != null ? formatTime(tape.durationSeconds) : null}
            next={candidate.durationSeconds != null ? formatTime(candidate.durationSeconds) : null}
          />
          <FieldDiff
            label="Chapters"
            current={tape.chapterCount != null ? String(tape.chapterCount) : null}
            next={candidate.chapterCount != null ? String(candidate.chapterCount) : null}
          />
        </div>
      ) : null}
    </Modal>
  )
}

/** Trim a string to null when it's blank, so "" reads as "no value". */
function nv(s: string | null): string | null {
  return s && s.trim() ? s : null
}

function FieldDiff({ label, current, next }: { label: string; current: string | null; next: string | null }) {
  const losing = current !== null && next === null // had data, refresh returns none
  const changed = (current ?? '') !== (next ?? '')
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
