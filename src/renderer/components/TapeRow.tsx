import type { Tape, TapeState } from '@shared/domain'
import type { ProgressEntry } from '@renderer/store/tapes'
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
          <div className="shrink-0 text-xs tabular-nums text-zinc-300">
            {formatTime(tape.durationSeconds)}
          </div>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
        {/* A downloaded tape's status is just "In library" (says nothing across a
            whole library), so show the uploader instead when we have one. */}
        <span className="min-w-0 truncate">
          {tape.state === 'downloaded' && tape.uploader
            ? tape.uploader
            : tapeStatusLabel(tape, progress)}
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
    ? 'border-zinc-100 ring-1 ring-zinc-100/40'
    : ''

  const baseBgBorder = archived
    ? 'bg-zinc-950/40 border-zinc-700/70 hover:border-zinc-700'
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
      return 'bg-red-900/30 border-red-600/70 hover:border-red-500'
    case 'paused':
      return 'bg-amber-900/30 border-amber-600/70 hover:border-amber-500'
    case 'listing':
      return 'bg-violet-900/30 border-violet-600/70 hover:border-violet-500'
    case 'downloading':
      return 'bg-sky-900/30 border-sky-600/70 hover:border-sky-500'
    case 'queued':
    case 'probing':
    case 'ready':
      return 'bg-teal-900/30 border-teal-600/70 hover:border-teal-500'
    case 'downloaded':
    default:
      return 'bg-zinc-900/60 border-zinc-700 hover:border-zinc-600'
  }
}
