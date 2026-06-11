import { useEffect, useState } from 'react'
import type { Tape } from '@shared/domain'
import type { RefreshedMetadata } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import { useToastStore } from '@renderer/store/toast'
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
 *
 * Only the fields that can genuinely improve from the source are shown: title,
 * uploader, and description. Duration and chapter count are fixed by the
 * downloaded file, so they can't change unless it's replaced.
 */
export function RefreshMetadataModal({ tape, onClose }: { tape: Tape; onClose: () => void }) {
  const [candidate, setCandidate] = useState<RefreshedMetadata | null>(null)
  const [currentDescription, setCurrentDescription] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const [applying, setApplying] = useState(false)
  const notify = useToastStore((s) => s.notify)

  const probed = candidate !== null

  // The current description lives in the sidecar, not on the tape — load it so the
  // "Current" column can show it (and decide whether the row appears at all).
  useEffect(() => {
    let cancelled = false
    ipcInvoke('library:getSidecar', { tapeId: tape.id })
      .then((s) => {
        if (cancelled) return
        const d = (s as Record<string, unknown>)['description']
        setCurrentDescription(typeof d === 'string' && d.trim() ? d : null)
      })
      .catch((err) => log.debug('sidecar load failed', { tapeId: tape.id, error: describeError(err) }))
    return () => { cancelled = true }
  }, [tape.id])

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

  const newDescription = probed ? nv(candidate?.description ?? null) : null
  // The description row only appears when one side has something worth comparing.
  const showDescription = !!nv(currentDescription) || !!newDescription

  // After a check, compare the source field by field against what's saved. When
  // they match there's nothing to apply, so Apply is disabled and the note says
  // so — a successful re-probe that changed nothing shouldn't look like pending work.
  const same = (a: string | null, b: string | null) => (a ?? '') === (b ?? '')
  const dirty =
    probed &&
    !(
      same(nv(tape.title), nv(candidate?.title ?? null)) &&
      same(nv(tape.uploader), nv(candidate?.uploader ?? null)) &&
      same(nv(currentDescription), newDescription)
    )

  // The primary action is always the natural next step: check the source until
  // there's something to review, then apply it. Re-checking stays available as a
  // secondary once a candidate is in hand. The per-cell spinners now signal an
  // in-flight check, so the check buttons just disable — no redundant button spinner.
  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={applying}>Cancel</Button>
      {probed && (
        <Button variant="secondary" onClick={() => void checkSource()} disabled={probing || applying}>
          Check again
        </Button>
      )}
      {probed ? (
        <Button variant="primary" onClick={() => void apply()} loading={applying} disabled={!dirty}>
          {applying ? 'Applying…' : 'Apply'}
        </Button>
      ) : (
        <Button variant="primary" onClick={() => void checkSource()} disabled={probing}>
          Check source
        </Button>
      )}
    </>
  )

  return (
    <Modal title="Refresh metadata" onClose={onClose} size="4xl" footer={footer} closeDisabled={applying}>
      <div className="space-y-3">
        {probed && !dirty ? (
          // A successful check that found nothing new. Said warmly, with a check
          // mark, so it reads as "all good" rather than a broken Apply button — and
          // it spells out that this is exactly why there's nothing to apply.
          <div className="flex items-center gap-2.5 rounded-md border border-teal-800/60 bg-teal-950/30 px-3 py-2.5 text-sm text-zinc-200">
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              className="shrink-0 text-teal-400"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
            <span>Up to date — the source matches your saved metadata, so there’s nothing to apply.</span>
          </div>
        ) : (
          <p className="text-xs text-zinc-400">
            {probed
              ? 'Nothing changes unless you apply. A value shown in amber would replace existing data with nothing — cancel if that isn’t what you want.'
              : 'Your saved metadata is shown below. It’s almost always fine — check the source only if you have reason to think the page now has better data. Nothing is fetched or changed until you do.'}
          </p>
        )}
        {error && (
          <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
        )}
        {/* One grid for the header and every row, so the three columns line up. The
            label column is auto-sized (tight to the widest label), making the gap to
            "Current" match the gap between "Current" and "New" rather than dwarfing it. */}
        <div className="grid grid-cols-[auto_1fr_1fr] items-start gap-x-6 gap-y-2.5 text-xs">
          <div />
          <div className="font-medium text-zinc-500">Current</div>
          <div className="font-medium text-zinc-500">New</div>
          <FieldDiff label="Title" probed={probed} probing={probing} current={nv(tape.title)} next={nv(candidate?.title ?? null)} />
          <FieldDiff label="Uploader" probed={probed} probing={probing} current={nv(tape.uploader)} next={nv(candidate?.uploader ?? null)} />
          {showDescription && (
            <DescriptionDiff probed={probed} probing={probing} current={nv(currentDescription)} next={newDescription} />
          )}
        </div>
      </div>
    </Modal>
  )
}

/** Trim a string to null when it's blank, so "" reads as "no value". */
function nv(s: string | null): string | null {
  return s && s.trim() ? s : null
}

/** A row in the comparison grid: three cells (label, current, new) the parent
 *  grid lays out. Until the source has been checked, the New column is blank by
 *  design — not a data-loss warning — so the amber/changed cues only apply once
 *  probed. While a check is in flight the New cell shows a spinner in place of the
 *  value it's about to hold, rather than a single one beside the column header. */
function FieldDiff({
  label,
  current,
  next,
  probed,
  probing,
}: {
  label: string
  current: string | null
  next: string | null
  probed: boolean
  probing: boolean
}) {
  const losing = probed && current !== null && next === null // had data, refresh returns none
  const changed = probed && (current ?? '') !== (next ?? '')
  return (
    <>
      <div className="text-zinc-500">{label}</div>
      <div className="min-w-0 break-words text-zinc-400">{current ?? '—'}</div>
      <div className={'min-w-0 break-words ' + (losing ? 'text-amber-300' : changed ? 'text-zinc-100' : 'text-zinc-400')}>
        {probing ? <Spinner /> : next ?? '—'}
      </div>
    </>
  )
}

/**
 * The description, current vs new — too long to read inline, so each side is a
 * read-only scrollable box. It's not an input, so it carries the modal's own
 * background rather than the darker input fill. Nobody studies a full description
 * here; this is just enough to judge whether the source's version is better.
 */
function DescriptionDiff({
  current,
  next,
  probed,
  probing,
}: {
  current: string | null
  next: string | null
  probed: boolean
  probing: boolean
}) {
  const losing = probed && current !== null && next === null
  return (
    <>
      <div className="text-zinc-500">Description</div>
      <DescBox text={current} />
      <DescBox text={next} losing={losing} probing={probing} />
    </>
  )
}

function DescBox({ text, losing, probing }: { text: string | null; losing?: boolean; probing?: boolean }) {
  if (probing) return <Spinner />
  if (text === null) {
    return <div className={losing ? 'text-amber-300' : 'text-zinc-500'}>—</div>
  }
  return (
    <div className="max-h-28 min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded border border-zinc-800 p-2 text-zinc-300">
      {text}
    </div>
  )
}
