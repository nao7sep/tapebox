import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react'
import { nextIndex } from '@renderer/lib/nextIndex'
import { isEditableElement } from '@renderer/lib/dom'

/**
 * The shared spine for the app's keyboard-navigable lists, in the ARIA
 * active-descendant shape: the CONTAINER is the single tab stop and owns the keys,
 * while its rows are non-focusable options. "Which list the arrows drive" is simply
 * which container holds DOM focus — there is no cross-list mode flag to keep in sync.
 *
 * Behaviour shared by every list (the convention's one spine):
 *   - Up/Down move the active item by one, Home/End jump to the ends, and (when
 *     `page` is given) PageUp/PageDown move by a page; all clamp at the ends — no
 *     wrap — via the shared nextIndex.
 *   - aria-activedescendant points at the active option so a screen reader tracks the
 *     active row while DOM focus stays on the container.
 *   - the active option is scrolled into view whenever it changes (safe with or
 *     without focus), so a selection that moves under playback or via the keyboard
 *     stays visible.
 *   - focus is never stolen by this hook; the container is focused by the user
 *     (Tab/click) or by a caller's deliberate focusList() hand-off.
 *
 * Per-list specifics — the ordered id sequence, the active id, what activation does,
 * and any extra command keys — are passed in. Ids are strings; a list whose key is
 * not a string (the Unboxed row, a chapter index) maps it to a stable string and back.
 */
export type ListboxKeyboard<E extends HTMLElement> = {
  /** Ref for the container element (the listbox). */
  ref: RefObject<E | null>
  /** Spread onto the container element. */
  listboxProps: {
    tabIndex: 0
    'aria-activedescendant': string | undefined
    onKeyDown: (e: KeyboardEvent) => void
  }
  /** DOM id for an option, namespaced per list so ids stay unique across lists. */
  optionId: (itemId: string) => string
  /** Imperatively focus the container — for a deliberate hand-off (e.g. a view switch). */
  focusList: () => void
}

export function useListboxKeyboard<E extends HTMLElement = HTMLElement>(opts: {
  itemIds: string[]
  activeId: string | null
  onActivate: (id: string) => void
  /** Namespace for option DOM ids, e.g. 'tape' / 'box' / 'chap'. */
  idPrefix: string
  page?: number
  /** Extra keys handled before navigation; return true if the key was consumed. */
  onCommandKey?: (e: KeyboardEvent, activeId: string | null) => boolean
}): ListboxKeyboard<E> {
  const { itemIds, activeId, onActivate, idPrefix, page, onCommandKey } = opts
  const ref = useRef<E | null>(null)
  const optionId = (itemId: string) => `${idPrefix}-opt-${itemId}`

  // The keydown handler reads live state through a ref so the container binds a stable
  // handler rather than re-subscribing every render.
  const stateRef = useRef({ itemIds, activeId, onActivate, page, onCommandKey })
  stateRef.current = { itemIds, activeId, onActivate, page, onCommandKey }

  // Keep the active option in view as it changes (under playback, or via the keys).
  useEffect(() => {
    if (activeId == null) return
    document.getElementById(optionId(activeId))?.scrollIntoView({ block: 'nearest' })
    // optionId is pure in idPrefix, which is stable for a given list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, idPrefix])

  function onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented) return
    const { itemIds, activeId, onActivate, page, onCommandKey } = stateRef.current

    if (onCommandKey?.(e, activeId)) return

    const key = e.key
    const isNav =
      key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End' ||
      (page != null && (key === 'PageDown' || key === 'PageUp'))
    if (!isNav || itemIds.length === 0) return
    e.preventDefault()

    const cur = activeId == null ? -1 : itemIds.indexOf(activeId)
    const from = cur < 0 ? -1 : cur
    const base = from < 0 ? 0 : from
    const target =
      key === 'Home' ? 0
      : key === 'End' ? itemIds.length - 1
      : page != null && key === 'PageDown' ? Math.min(itemIds.length - 1, base + page)
      : page != null && key === 'PageUp' ? Math.max(0, base - page)
      : nextIndex(from, itemIds.length, key === 'ArrowDown' ? 1 : -1)
    onActivate(itemIds[target])
  }

  return {
    ref,
    listboxProps: {
      tabIndex: 0,
      'aria-activedescendant': activeId != null && itemIds.includes(activeId) ? optionId(activeId) : undefined,
      onKeyDown,
    },
    optionId,
    focusList: () => ref.current?.focus(),
  }
}

/**
 * Focus a list container on mount unless the user is already typing in a field — the
 * deliberate hand-off that keeps "switch to this view and the arrows just work"
 * without ever yanking the caret out of the archive search box. Mirrors the old
 * roving-focus guard (focus only when document.activeElement isn't editable).
 */
export function useAutoFocusList(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!isEditableElement(document.activeElement)) el.focus()
    // Run once on mount: a view switch remounts the list, which is exactly when the
    // hand-off should happen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
