import type { Item, ItemState } from '@shared/domain'
import { formatTime } from '@renderer/lib/format'

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

  return (
    <button
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
          <div className="shrink-0 text-xs tabular-nums text-zinc-400">
            {formatTime(item.durationSeconds)}
          </div>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
        <span>{stateLabel}</span>
        {item.chapterCount != null && item.chapterCount > 0 && (
          <span>· {item.chapterCount} chapters</span>
        )}
        {item.archivedAtUtc && <span>· archived</span>}
      </div>
      {progress && (
        <div className="mt-2 h-0.5 w-full overflow-hidden rounded bg-zinc-800">
          <div
            className="h-full bg-zinc-200 transition-all"
            style={{ width: `${progress.percent}%` }}
          />
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
    ? 'bg-zinc-950/40 border-zinc-800/70 hover:border-zinc-700'
    : bgBorderForState(state)

  return `${baseBgBorder} ${selectionRing}`
}

function bgBorderForState(state: ItemState): string {
  switch (state) {
    case 'playlist':
      return 'bg-indigo-950/20 border-indigo-900/40 hover:border-indigo-700/60'
    case 'failed':
      return 'bg-red-950/30 border-red-900/50 hover:border-red-700/70'
    case 'downloading':
      return 'bg-sky-950/30 border-sky-900/50 hover:border-sky-700/70'
    case 'paused':
      return 'bg-zinc-900/30 border-zinc-800 hover:border-zinc-700'
    case 'downloaded':
      return 'bg-zinc-900/60 border-zinc-800 hover:border-zinc-700'
    case 'queued':
    case 'probing':
    case 'ready':
    default:
      return 'bg-zinc-900/40 border-zinc-800 hover:border-zinc-700'
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
