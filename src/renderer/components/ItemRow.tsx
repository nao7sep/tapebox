import type { Item } from '@shared/domain'
import { formatTime } from '@renderer/lib/format'

type Props = {
  item: Item
  progress: { phase: 'probing' | 'downloading'; percent: number } | undefined
  selected: boolean
  onSelect: () => void
}

export function ItemRow({ item, progress, selected, onSelect }: Props) {
  const stateLabel = labelFor(item, progress)
  return (
    <button
      onClick={onSelect}
      className={
        'block w-full rounded border px-3 py-2 text-left transition ' +
        (selected
          ? 'border-zinc-600 bg-zinc-800/60'
          : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700')
      }
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1 truncate text-sm">
          {item.title ?? item.sourceUrl}
        </div>
        {item.durationSeconds != null && (
          <div className="text-xs text-zinc-500">{formatTime(item.durationSeconds)}</div>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
        <span>{stateLabel}</span>
        {item.chapterCount != null && item.chapterCount > 0 && (
          <span>· {item.chapterCount} chapters</span>
        )}
        {item.archivedAtUtc && <span>· archived</span>}
      </div>
      {progress && (
        <div className="mt-2 h-0.5 w-full overflow-hidden rounded bg-zinc-800">
          <div
            className="h-full bg-zinc-300 transition-all"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      )}
    </button>
  )
}

function labelFor(item: Item, progress: Props['progress']): string {
  if (progress) return `${progress.phase} · ${progress.percent.toFixed(0)}%`
  if (item.state === 'downloaded') return 'in library'
  if (item.state === 'failed') return 'failed'
  if (item.state === 'paused') return 'paused'
  return item.state
}
