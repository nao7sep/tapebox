import type { Tape } from '@shared/domain'
import { nowUtcIso } from '@shared/utc'
import { frontOrders } from '@shared/order'
import { ipcInvoke } from '@renderer/ipc/client'
import { visibleTapes } from '@renderer/lib/tapeOrder'
import { useTapesStore } from '@renderer/store/tapes'
import { useFilterStore } from '@renderer/store/filter'
import { useArchiveStore } from '@renderer/store/archive'
import { useBoxesStore } from '@renderer/store/boxes'
import { useSelectionStore } from '@renderer/store/selection'
import { runTapeAction } from '@renderer/lib/runTapeAction'
import type { TapeAction } from '@renderer/store/tapeActionResults'

/**
 * The selection layer for tape actions.
 *
 * One principle keeps this from becoming a tangle of "after X do Y": selection is
 * the single source of truth, and the view follows it — the selected row is its
 * listbox's active descendant, scrolled into view. So the only thing an action must
 * get right is WHAT ENDS UP SELECTED, and there are exactly two policies:
 *
 *   keep: 'list' — the item left the current list; move selection to its neighbor
 *                  so the user can keep working the list. Used by keyboard shortcuts
 *                  and drag — you're triaging where you are.
 *   keep: 'tape' — follow the item to wherever it landed and select it there. Used
 *                  by the detail-pane buttons — you're focused on that one video.
 *
 * The CALLER picks the policy; the layer never inspects the event source, so there's
 * no fragile "was this a mouse or a key" guessing. Archive / unarchive / move are
 * local session writes, so we relocate optimistically — the item leaves its list
 * at once — then roll back and retain a per-tape result if persistence rejects.
 * The IPC re-emit settles the exact order on success. Removal lives
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
 *  The selected row becomes its listbox's active descendant and scrolls into view;
 *  a view switch also hands focus to that list (see useAutoFocusList). */
export function revealTape(tapeId: string, dest: { archived: boolean; boxId: string | null }): void {
  useFilterStore.getState().setFilter(dest.archived ? 'archived' : 'inbox')
  if (dest.archived) {
    useArchiveStore.getState().setQuery('') // show the box, not search results
    useArchiveStore.getState().selectBox(dest.boxId)
  }
  useSelectionStore.getState().select(tapeId)
}

/** A front-of-list `order` for the destination list, so an optimistic move lands the
 *  tape at the top at once — matching where the IPC re-emit will file it — instead of
 *  briefly showing it at its old position before the authoritative order arrives. */
function frontOrderFor(dest: { archived: boolean; boxId: string | null }, excludeId: string): number {
  const members = useTapesStore.getState().tapes.filter((t) =>
    t.id !== excludeId &&
    (dest.archived ? !!t.archivedAtUtc && t.boxId === dest.boxId : !t.archivedAtUtc),
  )
  return frontOrders(members.map((t) => t.order), 1)[0]
}

/** Run a relocation optimistically (so the item leaves its list now), persist it,
 *  then apply the chosen selection policy. */
function relocate(
  tape: Tape,
  patch: Partial<Tape>,
  dest: { archived: boolean; boxId: string | null },
  keep: Keep,
  action: TapeAction,
  operation: string,
  userMessage: string,
  persist: () => Promise<unknown>,
): void {
  const advance = keep === 'list' ? advanceSelection(tape) : null
  // Place it at the front of the destination optimistically so it doesn't flash at
  // its old order before boxes:place / library:archive re-emit the authoritative one.
  const optimistic = { ...tape, ...patch, order: frontOrderFor(dest, tape.id) }
  useTapesStore.getState().upsert(optimistic)
  if (advance) advance()
  else revealTape(tape.id, dest)

  void runTapeAction(tape.id, action, operation, userMessage, persist).then((succeeded) => {
    if (succeeded) return
    const current = useTapesStore.getState().tapes.find((candidate) => candidate.id === tape.id)
    if (!current) return
    if (current.archivedAtUtc !== optimistic.archivedAtUtc || current.boxId !== optimistic.boxId) return
    useTapesStore.getState().upsert(tape)
    if (keep === 'tape') {
      revealTape(tape.id, { archived: !!tape.archivedAtUtc, boxId: tape.boxId })
    }
  })
}

/** Archive a downloaded tape — it goes to the top of Unboxed. No-op otherwise. */
export function archiveTape(tape: Tape, keep: Keep): void {
  if (tape.state !== 'downloaded' || tape.archivedAtUtc) return
  relocate(
    tape,
    { archivedAtUtc: nowUtcIso(), boxId: null },
    { archived: true, boxId: null },
    keep,
    'archive',
    'tape archive failed',
    'This tape could not be archived. It remains in the Inbox; try again.',
    () => ipcInvoke('library:archive', { tapeIds: [tape.id] }),
  )
}

/** Unarchive a tape — it returns to the top of the inbox. No-op if not archived. */
export function unarchiveTape(tape: Tape, keep: Keep): void {
  if (!tape.archivedAtUtc) return
  relocate(
    tape,
    { archivedAtUtc: null, boxId: null },
    { archived: false, boxId: null },
    keep,
    'unarchive',
    'tape unarchive failed',
    'This tape could not be moved to the Inbox. It remains archived; try again.',
    () => ipcInvoke('library:unarchive', { tapeIds: [tape.id] }),
  )
}

/** File an archived tape into a box (null = Unboxed). No-op if not archived or
 *  already there. */
export function moveTapeToBox(tape: Tape, boxId: string | null, keep: Keep): void {
  if (!tape.archivedAtUtc || boxId === tape.boxId) return
  relocate(
    tape,
    { boxId },
    { archived: true, boxId },
    keep,
    'placement',
    'tape box placement failed',
    'This tape could not be moved to that box. Its previous location remains in use; try again.',
    () => ipcInvoke('boxes:place', { tapeIds: [tape.id], boxId }),
  )
}

export function copyTapeSourceUrl(tapeId: string, sourceUrl: string): Promise<boolean> {
  return runTapeAction(
    tapeId,
    'copy-url',
    'source URL copy failed',
    'The source URL could not be copied. Try Copy URL again.',
    () => navigator.clipboard.writeText(sourceUrl),
  )
}

export function openTapeSourceUrl(tapeId: string, sourceUrl: string): Promise<boolean> {
  return runTapeAction(
    tapeId,
    'open-url',
    'source URL open failed',
    'The source URL could not be opened in your browser. Try Open URL again.',
    () => ipcInvoke('app:openExternal', { url: sourceUrl }),
  )
}
