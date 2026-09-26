import { useEffect, useState } from 'react'
import type { Tape } from '@shared/domain'
import type { RefreshedMetadata } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import { Modal } from './Modal'
import { Button, InlineError, Spinner } from './ui'
import { CheckIcon } from './Icon'
import { PassiveScrollRegion } from './PassiveScrollRegion'
import { presentFailure } from '@renderer/lib/presentFailure'
import { useI18n } from '@renderer/i18n/I18nContext'
import { message, type Message } from '@shared/i18n/translate'

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
  const [error, setError] = useState<Message | null>(null)
  const [probing, setProbing] = useState(false)
  const t = useI18n()
  const [applying, setApplying] = useState(false)

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
      setError(presentFailure(err, message('refresh.checkFailed'), 'metadata source check failed'))
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
      onClose()
    } catch (err) {
      setError(presentFailure(err, message('refresh.applyFailed'), 'metadata apply failed'))
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
      <Button variant="ghost" onClick={onClose} disabled={applying}>{t.t('common.cancel')}</Button>
      {probed && (
        <Button variant="secondary" onClick={() => void checkSource()} disabled={probing || applying}>
          {t.t('refresh.checkAgain')}
        </Button>
      )}
      {probed ? (
        <Button variant="primary" onClick={() => void apply()} loading={applying} disabled={!dirty}>
          {t.t(applying ? 'refresh.applying' : 'refresh.apply')}
        </Button>
      ) : (
        <Button variant="primary" onClick={() => void checkSource()} disabled={probing}>
          {t.t('refresh.checkSource')}
        </Button>
      )}
    </>
  )

  return (
    <Modal title={t.t('refresh.title')} onClose={onClose} size="4xl" footer={footer} closeDisabled={applying}>
      <div className="space-y-3">
        {probed && !dirty ? (
          // A successful check that found nothing new. Said warmly, with a check
          // mark, so it reads as "all good" rather than a broken Apply button — and
          // it spells out that this is exactly why there's nothing to apply.
          <div className="flex items-center gap-2.5 rounded-md border border-calm-line bg-calm-tint px-3 py-2.5 text-sm text-fg-emphasis">
            <CheckIcon className="shrink-0 text-calm-fg" />
            <span>{t.t('refresh.upToDate')}</span>
          </div>
        ) : (
          <p className="text-xs text-fg-muted">
            {t.t(probed ? 'refresh.reviewHint' : 'refresh.introHint')}
          </p>
        )}
        {error && <InlineError>{t.text(error)}</InlineError>}
        {/* One grid for the header and every row, so the three columns line up. The
            label column is auto-sized (tight to the widest label), making the gap to
            "Current" match the gap between "Current" and "New" rather than dwarfing it. */}
        <div className="grid grid-cols-[auto_1fr_1fr] items-start gap-x-6 gap-y-2.5 text-xs">
          <div />
          <div className="font-medium text-fg-subtle">{t.t('refresh.current')}</div>
          <div className="font-medium text-fg-subtle">{t.t('refresh.new')}</div>
          <FieldDiff label={t.t('refresh.titleField')} probed={probed} probing={probing} current={nv(tape.title)} next={nv(candidate?.title ?? null)} />
          <FieldDiff label={t.t('detail.uploader')} probed={probed} probing={probing} current={nv(tape.uploader)} next={nv(candidate?.uploader ?? null)} />
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
      <div className="text-fg-subtle">{label}</div>
      <div className="min-w-0 break-words text-fg-muted">{current ?? '—'}</div>
      <div className={'min-w-0 break-words ' + (losing ? 'text-warning-fg' : changed ? 'text-fg-strong' : 'text-fg-muted')}>
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
  const t = useI18n()
  return (
    <>
      <div className="text-fg-subtle">{t.t('refresh.description')}</div>
      <DescBox text={current} />
      <DescBox text={next} losing={losing} probing={probing} />
    </>
  )
}

function DescBox({ text, losing, probing }: { text: string | null; losing?: boolean; probing?: boolean }) {
  const t = useI18n()
  if (probing) return <Spinner />
  if (text === null) {
    return <div className={losing ? 'text-warning-fg' : 'text-fg-subtle'}>—</div>
  }
  return (
    <PassiveScrollRegion
      label={t.t('refresh.description')}
      className="max-h-28 min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded border border-line-subtle p-2 text-fg"
    >
      {text}
    </PassiveScrollRegion>
  )
}
