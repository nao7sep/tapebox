import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useSelectionStore } from '@renderer/store/selection'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { LOOSE_LABEL } from '@shared/box-names'
import { TapeRow } from './TapeRow'

/**
 * Read-only results for an archive search: matching tapes across all boxes (the
 * query lives in the archive store; useVisibleTapes already filters to it). Each
 * row notes which box the tape is in so it can be located. Not sortable — order
 * is by recency, not a box order.
 */
export function SearchResults() {
  const tapes = useVisibleTapes()
  const boxes = useBoxesStore((s) => s.boxes)
  const progress = useTapesStore((s) => s.progress)
  const selectedId = useSelectionStore((s) => s.selectedId)
  const select = useSelectionStore((s) => s.select)

  if (tapes.length === 0) {
    return <div className="p-6 text-sm text-zinc-300">No archived tapes match.</div>
  }

  const boxName = (boxId: string | null) =>
    boxId === null ? LOOSE_LABEL : boxes.find((g) => g.id === boxId)?.name ?? LOOSE_LABEL

  return (
    <ul className="space-y-1.5 p-3">
      {tapes.map((tape) => (
        <li key={tape.id}>
          <TapeRow
            tape={tape}
            progress={progress[tape.id]}
            selected={tape.id === selectedId}
            onSelect={() => select(tape.id)}
          />
          <div className="mt-0.5 pl-3 text-xs text-zinc-400">in {boxName(tape.boxId)}</div>
        </li>
      ))}
    </ul>
  )
}
