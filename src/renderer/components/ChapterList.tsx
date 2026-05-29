import { formatTime } from '@renderer/lib/format'

type Chapter = { start_time: number; end_time: number; title: string }

type Props = {
  chapters: Chapter[]
  onSeek: (seconds: number) => void
}

export function ChapterList({ chapters, onSeek }: Props) {
  if (chapters.length === 0) {
    return <p className="text-xs text-zinc-400">No chapters in this video.</p>
  }
  return (
    <ol className="space-y-1">
      {chapters.map((c, i) => (
        <li key={i}>
          <button
            onClick={() => onSeek(c.start_time)}
            className="flex w-full items-baseline gap-3 rounded px-2 py-1 text-left text-sm hover:bg-zinc-800/60"
          >
            <span className="w-16 shrink-0 text-xs tabular-nums text-zinc-400">
              {formatTime(c.start_time)}
            </span>
            <span className="min-w-0 flex-1 truncate">{c.title}</span>
          </button>
        </li>
      ))}
    </ol>
  )
}
