import { useTapesStore } from '@renderer/store/tapes'
import { useSelectionStore } from '@renderer/store/selection'
import { useFilterStore, type Filter } from '@renderer/store/filter'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { TapeRow } from './TapeRow'

/**
 * One continuous list per tab. The filter and sort that define the on-screen
 * order live in lib/tapeOrder, so the list view, keyboard navigation, and
 * removal all agree on which tape is next.
 */
export function TapeList() {
  const progress = useTapesStore((s) => s.progress)
  const selectedId = useSelectionStore((s) => s.selectedId)
  const select = useSelectionStore((s) => s.select)
  const filter = useFilterStore((s) => s.filter)
  const visible = useVisibleTapes()

  if (visible.length === 0) {
    return (
      <div className="p-6 text-sm text-zinc-300">
        {emptyMessageFor(filter)}
      </div>
    )
  }

  return (
    <ul className="space-y-1.5 p-3">
      {visible.map((tape) => (
        <li key={tape.id}>
          <TapeRow
            tape={tape}
            progress={progress[tape.id]}
            selected={tape.id === selectedId}
            onSelect={() => select(tape.id)}
          />
        </li>
      ))}
    </ul>
  )
}

function emptyMessageFor(filter: Filter): string {
  return filter === 'archived' ? 'No archived tapes yet.' : 'No tapes here yet.'
}
