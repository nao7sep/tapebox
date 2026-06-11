import type { Tape } from '@shared/domain'
import { nowUtcIso } from '@shared/utc'
import { ipcInvoke } from '@renderer/ipc/client'
import { visibleTapes } from '@renderer/lib/tapeOrder'
import { useTapesStore } from '@renderer/store/tapes'
import { useFilterStore } from '@renderer/store/filter'
import { useArchiveStore } from '@renderer/store/archive'
import { useBoxesStore } from '@renderer/store/boxes'
import { useSelectionStore } from '@renderer/store/selection'

/**
 * The selection layer for tape actions.
 *
 * One principle keeps this from becoming a tangle of "after X do Y": selection is
 * the single source of truth, and focus is derived from it — a selected TapeRow
 * focuses and scrolls itself. So the only thing an action must get right is WHAT
 * ENDS UP SELECTED, and there are exactly two policies:
 *
 *   keep: 'list' — the item left the current list; move selection to its neighbor
 *                  so the user can keep working the list. Used by keyboard shortcuts
 *                  and drag — you're triaging where you are.
 *   keep: 'tape' — follow the item to wherever it landed and select it there. Used
 *                  by the detail-pane buttons — you're focused on that one video.
 *
 * The CALLER picks the policy; the layer never inspects the event source, so there's
 * no fragile "was this a mouse or a key" guessing. Archive / unarchive / move are
 * local, can't-fail session writes, so we relocate optimistically — the item leaves
 * its list at once — and let the IPC re-emit settle the exact order. Removal lives
 * in useTapeRemoval (it needs the confirm modal and a video-handle release) but
 * reuses advanceSelection from here, so it follows the same 'list' policy.
 */

export type Keep = 'list' | 'tape'

/** The list the user is currently looking at, computed fresh from the stores so an
 *  action invoked from an event handler always sees the latest state. */
export function currentVisibleTapes(): Tape[] {
  return visibleTapes(
    useTapesStore.getState().tapes,
    useFilterStore.getState().filter,
    useArchiveStore.getState().selectedBoxId,
    useArchiveStore.getState().query,
    useBoxesStore.getState().boxes,
  )
}

/** The id to select after `tape` leaves the current list: next, else previous, else
 *  none. */
export function neighborOf(tape: Tape): string | null {
  const visible = currentVisibleTapes()
  const idx = visible.findIndex((t) => t.id === tape.id)
  if (idx === -1) return null
  return (visible[idx + 1] ?? visible[idx - 1])?.id ?? null
}

/**
 * The 'list' policy, captured BEFORE the list changes: returns a function to run
 * after the action that selects the leaving tape's neighbor — but only if that tape
 * was the selected one. Dragging or removing some other row must never steal the
 * current selection.
 */
export function advanceSelection(tape: Tape): () => void {
  if (useSelectionStore.getState().selectedId !== tape.id) return () => {}
  const next = neighborOf(tape)
  return () => useSelectionStore.getState().select(next)
}

/** The 'tape' policy: point the view at where the tape now lives and select it.
 *  Focus and scroll follow because the selected row handles them itself. */
export function revealTape(tapeId: string, dest: { archived: boolean; boxId: string | null }): void {
  useFilterStore.getState().setFilter(dest.archived ? 'archived' : 'inbox')
  if (dest.archived) {
    useArchiveStore.getState().setQuery('') // show the box, not search results
    useArchiveStore.getState().selectBox(dest.boxId)
  }
  useSelectionStore.getState().select(tapeId)
}

/** Run a relocation optimistically (so the item leaves its list now), persist it,
 *  then apply the chosen selection policy. */
function relocate(
  tape: Tape,
  patch: Partial<Tape>,
  dest: { archived: boolean; boxId: string | null },
  keep: Keep,
  persist: () => void,
): void {
  const advance = keep === 'list' ? advanceSelection(tape) : null
  useTapesStore.getState().upsert({ ...tape, ...patch })
  persist()
  if (advance) advance()
  else revealTape(tape.id, dest)
}

/** Archive a downloaded tape — it goes to the top of Unboxed. No-op otherwise. */
export function archiveTape(tape: Tape, keep: Keep): void {
  if (tape.state !== 'downloaded' || tape.archivedAtUtc) return
  relocate(tape, { archivedAtUtc: nowUtcIso(), boxId: null }, { archived: true, boxId: null }, keep, () =>
    void ipcInvoke('library:archive', { tapeIds: [tape.id] }),
  )
}

/** Unarchive a tape — it returns to the top of the inbox. No-op if not archived. */
export function unarchiveTape(tape: Tape, keep: Keep): void {
  if (!tape.archivedAtUtc) return
  relocate(tape, { archivedAtUtc: null, boxId: null }, { archived: false, boxId: null }, keep, () =>
    void ipcInvoke('library:unarchive', { tapeIds: [tape.id] }),
  )
}

/** File an archived tape into a box (null = Unboxed). No-op if not archived or
 *  already there. */
export function moveTapeToBox(tape: Tape, boxId: string | null, keep: Keep): void {
  if (!tape.archivedAtUtc || boxId === tape.boxId) return
  relocate(tape, { boxId }, { archived: true, boxId }, keep, () =>
    void ipcInvoke('boxes:place', { tapeIds: [tape.id], boxId }),
  )
}
