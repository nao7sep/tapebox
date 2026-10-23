import { useEffect, useRef, useState } from 'react'
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

type DescriptionLoad = { tapeId: string } & (
  | { status: 'loading' }
  | { status: 'loaded'; description: string | null }
  | { status: 'failed'; error: Message }
)

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
  const [descriptionLoad, setDescriptionLoad] = useState<DescriptionLoad>({ tapeId: tape.id, status: 'loading' })
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [error, setError] = useState<Message | null>(null)
  const [probing, setProbing] = useState(false)
  const t = useI18n()
  const [applying, setApplying] = useState(false)

  const probeRequest = useRef<string | null>(null)
  function cancelProbe() {
    const requestId = probeRequest.current
    probeRequest.current = null
    if (requestId) void ipcInvoke('library:cancelMetadataProbe', { requestId })
      .catch((err) => log.debug('metadata probe cancellation failed', { error: describeError(err) }))
  }
  function close() {
    cancelProbe()
    onClose()
  }
  useEffect(() => {
    setCandidate(null)
    setProbing(false)
    return cancelProbe
  }, [tape.id])

  const probed = candidate !== null
  const currentLoad: DescriptionLoad = descriptionLoad.tapeId === tape.id
    ? descriptionLoad
    : { tapeId: tape.id, status: 'loading' }
  const descriptionKnown = currentLoad.status === 'loaded'
  const currentDescription = currentLoad.status === 'loaded' ? currentLoad.description : null

  // The current description lives in the sidecar, not on the tape — load it so the
  // "Current" column can show it (and decide whether the row appears at all).
  useEffect(() => {
    let cancelled = false
    setDescriptionLoad({ tapeId: tape.id, status: 'loading' })
    ipcInvoke('library:getSidecar', { tapeId: tape.id })
      .then((s) => {
        if (cancelled) return
        const d = (s as Record<string, unknown>)['description']
        setDescriptionLoad({ tapeId: tape.id, status: 'loaded', description: typeof d === 'string' ? nv(d) : null })
      })
      .catch((err) => {
        const failure = presentFailure(err, message('refresh.loadFailed'), 'saved metadata description load failed')
        if (!cancelled) setDescriptionLoad({ tapeId: tape.id, status: 'failed', error: failure })
      })
    return () => { cancelled = true }
  }, [tape.id, loadAttempt])

  async function checkSource() {
    if (probeRequest.current) return
    const requestId = crypto.randomUUID()
    probeRequest.current = requestId
    setProbing(true)
    setError(null)
    try {
      const result = await ipcInvoke('library:probeMetadata', { tapeId: tape.id, requestId })
      if (probeRequest.current === requestId) setCandidate(result)
    } catch (err) {
      if (probeRequest.current === requestId) setError(presentFailure(err, message('refresh.checkFailed'), 'metadata source check failed'))
    } finally {
      if (probeRequest.current === requestId) {
        probeRequest.current = null
        setProbing(false)
      }
    }
  }

  async function apply() {
    if (!candidate || !descriptionKnown) return
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
  // Unknown is not empty: keep the row while loading or recovering, and require
  // the saved value before allowing Apply to replace it with the source's value.
  const showDescription = !descriptionKnown || !!nv(currentDescription) || !!newDescription

  // After a check, compare the source field by field against what's saved. When
  // they match there's nothing to apply, so Apply is disabled and the note says
  // so — a successful re-probe that changed nothing shouldn't look like pending work.
  const same = (a: string | null, b: string | null) => (a ?? '') === (b ?? '')
  const dirty =
    probed &&
    descriptionKnown &&
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
      <Button variant="ghost" onClick={close} disabled={applying}>{t.t('common.cancel')}</Button>
      {probed && (
        <Button variant="secondary" onClick={() => void checkSource()} disabled={probing || applying}>
          {t.t('refresh.checkAgain')}
        </Button>
      )}
      {probed ? (
        <Button variant="primary" onClick={() => void apply()} loading={applying} disabled={!dirty || probing || !descriptionKnown}>
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
    <Modal title={t.t('refresh.title')} onClose={close} size="4xl" footer={footer} closeDisabled={applying}>
      <div className="space-y-3">
        {probed && descriptionKnown && !dirty ? (
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
            <DescriptionDiff
              probed={probed}
              probing={probing}
              currentLoad={currentLoad}
              next={newDescription}
              onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
              retryDisabled={applying}
            />
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
      <div className="whitespace-nowrap text-fg-subtle">{label}</div>
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
  currentLoad,
  next,
  probed,
  probing,
  onRetry,
  retryDisabled,
}: {
  currentLoad: DescriptionLoad
  next: string | null
  probed: boolean
  probing: boolean
  onRetry: () => void
  retryDisabled: boolean
}) {
  const current = currentLoad.status === 'loaded' ? currentLoad.description : null
  const losing = probed && current !== null && next === null
  const t = useI18n()
  return (
    <>
      <div className="whitespace-nowrap text-fg-subtle">{t.t('refresh.description')}</div>
      {currentLoad.status === 'failed' ? (
        <div className="min-w-0 space-y-2">
          <InlineError>{t.text(currentLoad.error)}</InlineError>
          <Button variant="secondary" size="sm" onClick={onRetry} disabled={retryDisabled}>
            {t.t('refresh.retryLoad')}
          </Button>
        </div>
      ) : (
        <DescBox text={current} probing={currentLoad.status === 'loading'} />
      )}
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
