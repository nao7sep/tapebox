import { formatTime } from '@renderer/lib/format'
import { useNavStore } from '@renderer/store/nav'
import { useRovingFocus } from '@renderer/lib/useRovingFocus'

type Chapter = { start_time: number; end_time: number; title: string }

type Props = {
  chapters: Chapter[]
  /** Chapter under the playhead — highlighted, and the origin for Up/Down. */
  currentIndex: number
  /** Whether the chapter list is the active keyboard panel (then it takes focus). */
  active: boolean
  /** Jump to chapter `i` and make the chapter list the active panel. */
  onActivate: (i: number) => void
}

export function ChapterList({ chapters, currentIndex, active, onActivate }: Props) {
  if (chapters.length === 0) {
    return <p className="text-xs text-zinc-300">No chapters in this video.</p>
  }
  // The list's single tab stop (roving tabindex): the current chapter, or the
  // first when the playhead is before any chapter.
  const tabbableIndex = currentIndex >= 0 ? currentIndex : 0
  return (
    <ol role="listbox" aria-label="Chapters" className="space-y-1">
      {chapters.map((c, i) => (
        <ChapterRow
          key={i}
          chapter={c}
          selected={i === currentIndex}
          active={active}
          tabbable={i === tabbableIndex}
          onActivate={() => onActivate(i)}
        />
      ))}
    </ol>
  )
}

/**
 * One chapter. The current chapter carries a persistent ring (the same selection
 * treatment as a tape row) so it stays marked whether or not the chapter list has
 * the keys — and since "current" is derived from the playhead, the ring follows
 * playback on its own. No click flash: the selection move *is* the feedback.
 */
function ChapterRow({
  chapter,
  selected,
  active,
  tabbable,
  onActivate,
}: {
  chapter: Chapter
  selected: boolean
  active: boolean
  tabbable: boolean
  onActivate: () => void
}) {
  const setActivePanel = useNavStore((s) => s.setActivePanel)
  const ref = useRovingFocus<HTMLButtonElement>(active, selected)
  return (
    <li role="presentation">
      <button
        ref={ref}
        role="option"
        aria-selected={selected}
        tabIndex={tabbable ? 0 : -1}
        onClick={onActivate}
        // Focusing a chapter routes Up/Down to the chapter list.
        onFocus={() => setActivePanel('chapters')}
        className={
          'flex w-full items-baseline gap-3 rounded border px-2 py-1 text-left text-sm hover:bg-zinc-800/60 focus:outline-none ' +
          (selected ? 'border-zinc-100 ring-1 ring-zinc-100/40' : 'border-transparent')
        }
      >
        <span className="w-16 shrink-0 text-xs tabular-nums text-zinc-300">
          {formatTime(chapter.start_time)}
        </span>
        <span className="min-w-0 flex-1 truncate">{chapter.title}</span>
      </button>
    </li>
  )
}
