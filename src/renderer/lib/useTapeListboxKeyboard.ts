import type { Tape } from '@shared/domain'
import { selectTape } from '@renderer/lib/selectTape'
import { useListboxKeyboard, useAutoFocusList, type ListboxKeyboard } from '@renderer/lib/useListboxKeyboard'

/** Page step for the tape lists' PageUp/PageDown (this layer has no viewport measure). */
const TAPE_LIST_PAGE = 10

/**
 * The keyboard spine shared by all three tape lists — the inbox, a box's tapes, and
 * the archive search results: arrow / Home / End / PageUp / PageDown navigation over
 * the visible tapes, selecting whichever one is arrowed to, plus a mount-time focus
 * hand-off so the arrows work the instant the view appears (without yanking the caret
 * out of the search box). Selecting is the only "activation" — the detail pane
 * follows the selection — so this layer carries no per-list command keys; the
 * selected-tape commands (A / Delete) live with the rest of them in DetailPane.
 */
export function useTapeListboxKeyboard<E extends HTMLElement>(
  visible: Tape[],
  selectedId: string | null,
): ListboxKeyboard<E> {
  const kb = useListboxKeyboard<E>({
    itemIds: visible.map((t) => t.id),
    activeId: selectedId,
    onActivate: selectTape,
    idPrefix: 'tape',
    page: TAPE_LIST_PAGE,
  })
  useAutoFocusList(kb.ref)
  return kb
}
