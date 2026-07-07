import { formatTime } from '@renderer/lib/format'
import { useListboxKeyboard } from '@renderer/lib/useListboxKeyboard'

type Chapter = { start_time: number; end_time: number; title: string }

type Props = {
  chapters: Chapter[]
  /** Chapter under the playhead — highlighted, and the origin for Up/Down. */
  currentIndex: number
  /** Jump to chapter `i` (seek the video there). */
  onActivate: (i: number) => void
}

/**
 * The chapter list is a listbox whose active option is the chapter under the playhead
 * — so the highlight follows playback on its own, and Up/Down (while the list holds
 * focus) jump relative to wherever the video actually is. Clicking a chapter seeks to
 * it and, since the row sits inside the focusable container, hands Up/Down to this
 * list. Left/Right still seek the video from anywhere (DetailPane's window handler).
 */
export function ChapterList({ chapters, currentIndex, onActivate }: Props) {
  const kb = useListboxKeyboard<HTMLOListElement>({
    itemIds: chapters.map((_, i) => String(i)),
    activeId: currentIndex >= 0 ? String(currentIndex) : null,
    onActivate: (id) => onActivate(Number(id)),
    idPrefix: 'chap',
  })

  if (chapters.length === 0) {
    return <p className="text-xs text-zinc-300">No chapters in this video.</p>
  }

  return (
    <ol
      ref={kb.ref}
      {...kb.listboxProps}
      role="listbox"
      aria-label="Chapters"
      className="space-y-1 outline-none"
    >
      {chapters.map((c, i) => (
        <li key={i} role="presentation">
          {/* A non-focusable option (its listbox container holds the keys). The current
              chapter carries a persistent ring — the same selection treatment as a tape
              row — so it stays marked whether or not this list has focus; no click flash,
              the seek itself is the feedback. */}
          <div
            id={kb.optionId(String(i))}
            role="option"
            aria-selected={i === currentIndex}
            onClick={() => onActivate(i)}
            className={
              'flex w-full cursor-pointer items-baseline gap-3 rounded border px-2 py-1 text-left text-sm hover:bg-zinc-800/60 ' +
              (i === currentIndex ? 'border-zinc-100 ring-1 ring-zinc-100/40' : 'border-transparent')
            }
          >
            <span className="w-16 shrink-0 text-xs tabular-nums text-zinc-300">
              {formatTime(c.start_time)}
            </span>
            <span className="min-w-0 flex-1 truncate">{c.title}</span>
          </div>
        </li>
      ))}
    </ol>
  )
}
