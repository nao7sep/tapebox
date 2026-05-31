import { useEffect, useRef } from 'react'
import type { Item, ItemState } from '@shared/domain'
import { formatTime } from '@renderer/lib/format'
import { IndeterminateBar, ProgressBar } from './Progress'

type Props = {
  item: Item
  progress: { phase: 'probing' | 'downloading'; percent: number } | undefined
  selected: boolean
  onSelect: () => void
}

/**
 * Each row's background and default border carry the item's state at a glance
 * (failed = red, downloading = sky, downloaded = subtle, etc.). Selection /
 * focus brightens the border on top, so the selected item stands out from any
 * of these state colors without losing its state cue.
 */
export function ItemRow({ item, progress, selected, onSelect }: Props) {
  const stateLabel = labelFor(item, progress)
  const palette = paletteFor(item, selected)
  const ref = useRef<HTMLButtonElement>(null)

  // When a row becomes selected — by click, arrow keys, or after a removal —
  // move keyboard focus to it (and scroll it into view) so selection and focus
  // never land on different rows.
  useEffect(() => {
    if (!selected) return
    ref.current?.focus({ preventScroll: true })
    ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <button
      ref={ref}
      onClick={onSelect}
      className={
        'block w-full rounded-md border px-3 py-2 text-left transition focus:outline-none ' +
        palette
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1 truncate text-sm">
          {item.title ?? item.sourceUrl}
        </div>
        {item.durationSeconds != null && (
          <div className="shrink-0 text-xs tabular-nums text-zinc-300">
            {formatTime(item.durationSeconds)}
          </div>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-zinc-300">
        <span>{stateLabel}</span>
        {item.chapterCount != null && item.chapterCount > 0 && (
          <span>· {item.chapterCount} chapters</span>
        )}
        {item.archivedAtUtc && <span>· archived</span>}
      </div>
      {progress && (
        <div className="mt-2">
          {progress.phase === 'downloading' && progress.percent > 0 ? (
            <ProgressBar percent={progress.percent} />
          ) : (
            <IndeterminateBar />
          )}
        </div>
      )}
    </button>
  )
}

function paletteFor(item: Item, selected: boolean): string {
  const state = item.state
  const archived = !!item.archivedAtUtc

  // Selection overlays a bright border on top of the state palette so the
  // selected row is always obvious without erasing its state colour.
  const selectionRing = selected
    ? 'border-zinc-100 ring-1 ring-zinc-100/40 focus:border-zinc-100'
    : 'focus:border-zinc-500'

  const baseBgBorder = archived
    ? 'bg-zinc-950/40 border-zinc-700/70 hover:border-zinc-700'
    : bgBorderForState(state)

  return `${baseBgBorder} ${selectionRing}`
}

/**
 * Background tint by state. Downloaded items stay neutral zinc (settled); every
 * other state gets its own balanced hue so items needing attention stand out:
 * warm = needs you (failed/paused), violet = a dead-end to resolve (playlist),
 * cool = working automatically (downloading/queued).
 */
function bgBorderForState(state: ItemState): string {
  switch (state) {
    case 'failed':
      return 'bg-red-900/30 border-red-600/70 hover:border-red-500'
    case 'paused':
      return 'bg-amber-900/30 border-amber-600/70 hover:border-amber-500'
    case 'playlist':
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

function labelFor(item: Item, progress: Props['progress']): string {
  if (progress) return `${progress.phase} · ${progress.percent.toFixed(0)}%`
  if (item.state === 'playlist') return 'playlist or channel'
  if (item.state === 'downloaded') return 'in box'
  if (item.state === 'failed') return 'failed'
  if (item.state === 'paused') return 'paused'
  return item.state
}
