import type { Tape } from '@shared/domain'
import { ipcInvoke } from '@renderer/ipc/client'
import { useBoxesStore } from '@renderer/store/boxes'
import { moveTapeToBox } from '@renderer/lib/tapeActions'
import { Menu, MenuItem } from '@renderer/components/Menu'
import { UNBOXED_LABEL } from '@shared/box-names'
import { CheckIcon, PlusIcon } from './Icon'
import { presentFailure } from '@renderer/lib/presentFailure'
import { useTapeActionResultsStore } from '@renderer/store/tapeActionResults'

/**
 * Files an archived tape into a box (or Unboxed, or a brand-new box) via a small
 * dropdown — a deliberate "put this one there" click, so it uses the 'tape' policy:
 * the view follows the tape into its new box and keeps it selected. Drag-and-drop
 * hits the same moveTapeToBox but with the 'list' policy. The menu opens upward
 * since it lives in the bottom button row. The shared Menu owns open/close,
 * keyboard, and focus behavior; the ✓ marks the tape's current box.
 */
export function MoveToBoxButton({ tape }: { tape: Tape }) {
  const boxes = useBoxesStore((s) => s.boxes)
  const sorted = [...boxes].sort((a, b) => a.order - b.order)

  function moveTo(boxId: string | null) {
    moveTapeToBox(tape, boxId, 'tape')
  }

  async function newBoxAndMove() {
    useTapeActionResultsStore.getState().setResult(tape.id, 'placement', null)
    try {
      const box = await ipcInvoke('boxes:create', { name: 'New box' })
      moveTapeToBox(tape, box.id, 'tape')
    } catch (error) {
      useTapeActionResultsStore.getState().setResult(
        tape.id,
        'placement',
        presentFailure(
          error,
          'A new box could not be created, so this tape was not moved. Try again.',
          'box creation for tape placement failed',
        ),
      )
    }
  }

  return (
    <Menu
      label="Move to box"
      placement="top"
      maxHeight={256}
      contentClassName="w-52 rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
      trigger={({ ref, ...props }) => (
        <button
          {...props}
          ref={ref}
          className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-800/60"
        >
          Move to box
        </button>
      )}
    >
      <MenuItem onSelect={() => moveTo(null)} className={itemClass(tape.boxId === null)}>
        {tape.boxId === null ? <CheckIcon className="mr-1.5" /> : null}
        {UNBOXED_LABEL}
      </MenuItem>
      {sorted.map((g) => (
        <MenuItem key={g.id} onSelect={() => moveTo(g.id)} className={itemClass(tape.boxId === g.id)}>
          {tape.boxId === g.id ? <CheckIcon className="mr-1.5" /> : null}
          {g.name}
        </MenuItem>
      ))}
      <div className="my-1 border-t border-zinc-700" role="separator" />
      <MenuItem onSelect={() => void newBoxAndMove()} className="whitespace-nowrap">
        <PlusIcon className="mr-1.5" />
        New box
      </MenuItem>
    </Menu>
  )
}

function itemClass(active: boolean): string {
  return (
    'block w-full px-3 py-1.5 text-left text-sm transition ' +
    (active ? 'text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100')
  )
}
