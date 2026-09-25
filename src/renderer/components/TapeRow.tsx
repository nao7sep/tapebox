import type { Tape, TapeState } from '@shared/domain'
import { useTapesStore, type ProgressEntry } from '@renderer/store/tapes'
import { chapterCountLabel, formatTime } from '@renderer/lib/format'
import { tapeStatusLabel, isProcessing } from '@renderer/lib/tapeStatus'
import { IndeterminateBar, ProgressBar } from './Progress'
import { TapeActionResults } from './TapeActionResults'

type Props = {
  tape: Tape
  progress: ProgressEntry | undefined
  selected: boolean
  onSelect: () => void
  /** DOM id of this option, so its listbox's aria-activedescendant can target it. */
  id?: string
}


/**
 * A library row. Two lines: the title (with the running time right-aligned,
 * since length is what you scan for) and a muted meta line — the status label
 * plus chapter count. The background/border tint carries the tape's state at a
 * glance; selection brightens the border on top without erasing that state cue.
 *
 * A non-focusable option: its listbox container holds the single tab stop and the
 * keys, and points aria-activedescendant at the selected row's id. Clicking the row
 * selects the tape (and, since the row sits inside the focusable container, hands the
 * arrows to this list). No "archived" marker: a row only ever appears in a list
 * already filtered to one side (Inbox or Archived), so the flag would be the same on
 * every row.
 */
export function TapeRow({ tape, progress, selected, onSelect, id }: Props) {
  const palette = paletteFor(tape, selected)
  const stalled = useTapesStore((s) => s.stalled[tape.id] === true)

  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={
        'block w-full cursor-pointer rounded-md border px-3 py-2 text-left transition ' +
        palette
      }
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1 truncate text-sm">
          {tape.title ?? tape.sourceUrl}
        </div>
        {tape.durationSeconds != null && (
          <div className="shrink-0 text-xs tabular-nums text-fg">
            {formatTime(tape.durationSeconds)}
          </div>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-fg-muted">
        {/* A downloaded tape's status is just "In library" (says nothing across a
            whole library), so show the uploader instead when we have one. */}
        <span className="min-w-0 truncate">
          {tape.state === 'downloaded' && tape.uploader
            ? tape.uploader
            : tapeStatusLabel(tape, progress, stalled)}
        </span>
        {chapterCountLabel(tape.chapterCount) && (
          <span className="shrink-0">· {chapterCountLabel(tape.chapterCount)}</span>
        )}
      </div>
      {(progress || isProcessing(tape.state)) && (
        <div className="mt-2">
          {progress?.phase === 'downloading' && progress.percent > 0 ? (
            <ProgressBar percent={progress.percent} />
          ) : (
            <IndeterminateBar />
          )}
        </div>
      )}
      {!selected && <TapeActionResults tapeId={tape.id} className="mt-2" />}
    </div>
  )
}

function paletteFor(tape: Tape, selected: boolean): string {
  const state = tape.state
  const archived = !!tape.archivedAtUtc

  // Selection overlays a bright border on top of the state palette so the
  // selected row — the listbox's active descendant — is always obvious without
  // erasing its state colour.
  const selectionRing = selected
    ? 'border-selected ring-1 ring-selected/40'
    : ''

  const baseBgBorder = archived
    ? 'bg-row-archived border-line/70 hover:border-line'
    : bgBorderForState(state)

  return `${baseBgBorder} ${selectionRing}`
}

/**
 * Background tint by state. Downloaded tapes stay neutral zinc (settled); every
 * other state gets its own balanced hue so tapes needing attention stand out:
 * warm = needs you (failed/paused), violet = a dead-end to resolve (a page of videos),
 * cool = working automatically (downloading/queued).
 */
function bgBorderForState(state: TapeState): string {
  switch (state) {
    case 'failed':
      return 'bg-danger-row border-danger-line-strong hover:border-danger-line-hover'
    case 'paused':
      return 'bg-warning-row border-warning-line-strong hover:border-warning-line-hover'
    case 'listing':
      return 'bg-note-row border-note-line-strong hover:border-note-line-hover'
    case 'downloading':
      return 'bg-info-row border-info-line-strong hover:border-info-line-hover'
    case 'queued':
    case 'probing':
    case 'ready':
      return 'bg-calm-row border-calm-line-strong hover:border-calm-line-hover'
    case 'downloaded':
    default:
      return 'bg-row border-line hover:border-line-strong'
  }
}
