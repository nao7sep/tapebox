import { useTapesStore } from '@renderer/store/tapes'
import { useSelectionStore } from '@renderer/store/selection'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { selectTape } from '@renderer/lib/selectTape'
import { useTapeListboxKeyboard } from '@renderer/lib/useTapeListboxKeyboard'
import { TapeRow } from './TapeRow'
import { SortableTape } from './SortableTape'
import { InlineError } from './ui'

/**
 * The selected box's tapes, in manual order, as a sortable list. Reorder within
 * the box (drag a tape over another) and move between boxes (drag a tape onto a
 * box row) are both handled by the parent provider's completion mapping. Rows reuse the
 * shared TapeRow; the sortable wrapper is shared with the inbox.
 */
export function ArchiveTapeList({
  onReorder,
  orderError,
  onDismissOrderError,
}: {
  onReorder: (activeId: string, offset: -1 | 1) => void
  orderError: string | null
  onDismissOrderError: () => void
}) {
  const tapes = useVisibleTapes()
  const progress = useTapesStore((s) => s.progress)
  const selectedId = useSelectionStore((s) => s.selectedId)
  const kb = useTapeListboxKeyboard<HTMLUListElement>(tapes, selectedId, onReorder)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {orderError && (
        <InlineError className="m-3 mb-0 shrink-0" onDismiss={onDismissOrderError} dismissLabel="Dismiss box tape order error">
          {orderError}
        </InlineError>
      )}
      {tapes.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-6 text-sm text-zinc-300">This box is empty.</div>
      ) : (
        <ul
          ref={kb.ref}
          {...kb.listboxProps}
          role="listbox"
          aria-label="Box tapes"
          className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3 outline-none"
        >
          {tapes.map((tape, index) => (
            <SortableTape key={tape.id} id={tape.id} index={index}>
              <TapeRow
                tape={tape}
                progress={progress[tape.id]}
                selected={tape.id === selectedId}
                id={kb.optionId(tape.id)}
                onSelect={() => selectTape(tape.id)}
              />
            </SortableTape>
          ))}
        </ul>
      )}
    </div>
  )
}
