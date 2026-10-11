import { create } from 'zustand'
import type { Message } from '@shared/i18n/translate'
import type { Box, Tape } from '@shared/domain'
import type { OrderedItem } from '@renderer/lib/optimisticOrder'

/** The Inbox, box list, and one archived tape list settle independently. */
export type OrderList = 'inbox' | 'boxes' | `archive:${string}`
type PendingOrder = { active: Set<number>; confirmed: Map<string, number> }

function tapeList(tape: Tape): OrderList {
  return tape.archivedAtUtc ? tape.boxId === null ? 'archive:unboxed' : `archive:box:${tape.boxId}` : 'inbox'
}

function orders(items: readonly OrderedItem[]): Map<string, number> {
  return new Map(items.map(({ id, order }) => [id, order]))
}

type OrderFailuresState = {
  inbox: Message | null
  boxes: Message | null
  archiveTapes: Record<string, Message | undefined>
  attempts: Partial<Record<OrderList, number>>
  pending: Partial<Record<OrderList, PendingOrder>>
  beginAttempt: (list: OrderList, current: readonly OrderedItem[]) => number
  finishAttempt: (list: OrderList, attempt: number) => void
  confirmedOrder: (list: OrderList) => OrderedItem[]
  confirmTapes: (tapes: readonly Tape[]) => void
  confirmTapeRemoval: (ids: readonly string[]) => void
  confirmBoxes: (boxes: readonly Box[]) => void
  confirmCatalog: (tapes: readonly Tape[], boxes: readonly Box[]) => void
  isCurrentAttempt: (list: OrderList, attempt: number) => boolean
  setInbox: (message: Message | null) => void
  setBoxes: (message: Message | null) => void
  setArchiveTapes: (boxKey: string, message: Message | null) => void
}

/**
 * Session ownership for sortable-list results and attempts. Both outlive view
 * switches: only a later reorder of the same list supersedes its result.
 * Whole-row main updates can carry old order values during a pending write, so
 * rendered numeric equality cannot identify which reorder still owns a result.
 * Keep one confirmed arrangement only while saves physically overlap: nested
 * optimism is not a rollback base. Only the canonical IPC sync edge advances it;
 * every settlement retires its attempt, including superseded results.
 */
export const useOrderFailuresStore = create<OrderFailuresState>((set, get) => ({
  inbox: null,
  boxes: null,
  archiveTapes: {},
  attempts: {},
  pending: {},
  beginAttempt: (list, current) => {
    const attempt = (get().attempts[list] ?? 0) + 1
    set((state) => {
      const previous = state.pending[list]
      return {
        attempts: { ...state.attempts, [list]: attempt },
        pending: { ...state.pending, [list]: {
          active: new Set([...(previous?.active ?? []), attempt]),
          confirmed: previous?.confirmed ?? orders(current),
        } },
      }
    })
    return attempt
  },
  finishAttempt: (list, attempt) => set((state) => {
    const previous = state.pending[list]
    if (!previous?.active.has(attempt)) return state
    const active = new Set(previous.active)
    active.delete(attempt)
    const pending = { ...state.pending }
    if (active.size === 0) delete pending[list]
    else pending[list] = { ...previous, active }
    return { pending }
  }),
  confirmedOrder: (list) => [...(get().pending[list]?.confirmed ?? [])].map(([id, order]) => ({ id, order })),
  confirmTapes: (tapes) => set((state) => {
    const pending = { ...state.pending }
    for (const list of Object.keys(pending) as OrderList[]) {
      if (list === 'boxes') continue
      const group = pending[list]!
      const confirmed = new Map(group.confirmed)
      for (const tape of tapes) {
        if (tapeList(tape) === list) confirmed.set(tape.id, tape.order)
        else confirmed.delete(tape.id)
      }
      pending[list] = { ...group, confirmed }
    }
    return { pending }
  }),
  confirmTapeRemoval: (ids) => set((state) => {
    const pending = { ...state.pending }
    for (const list of Object.keys(pending) as OrderList[]) {
      if (list === 'boxes') continue
      const group = pending[list]!
      const confirmed = new Map(group.confirmed)
      for (const id of ids) confirmed.delete(id)
      pending[list] = { ...group, confirmed }
    }
    return { pending }
  }),
  confirmBoxes: (boxes) => set((state) => state.pending.boxes ? {
    pending: { ...state.pending, boxes: { ...state.pending.boxes, confirmed: orders(boxes) } },
  } : state),
  confirmCatalog: (tapes, boxes) => set((state) => {
    const pending = { ...state.pending }
    for (const list of Object.keys(pending) as OrderList[]) {
      pending[list] = { ...pending[list]!, confirmed: orders(list === 'boxes' ? boxes : tapes.filter((tape) => tapeList(tape) === list)) }
    }
    return { pending }
  }),
  isCurrentAttempt: (list, attempt) => get().attempts[list] === attempt,
  setInbox: (inbox) => set({ inbox }),
  setBoxes: (boxes) => set({ boxes }),
  setArchiveTapes: (boxKey, message) => set((state) => {
    const archiveTapes = { ...state.archiveTapes }
    if (message === null) delete archiveTapes[boxKey]
    else archiveTapes[boxKey] = message
    return { archiveTapes }
  }),
}))
