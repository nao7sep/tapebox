import { create } from 'zustand'
import type { Message } from '@shared/i18n/translate'
import type { OrderedItem } from '@renderer/lib/optimisticOrder'

/** The Inbox, box list, and one archived tape list settle independently. */
export type OrderList = 'inbox' | 'boxes' | `archive:${string}`
type PendingOrder = { active: Set<number>; confirmed: Map<string, number> }

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
  /** `saved` is the attempt's order when main's reply confirmed it, else null. */
  finishAttempt: (list: OrderList, attempt: number, saved: readonly OrderedItem[] | null) => void
  confirmedOrder: (list: OrderList) => OrderedItem[]
  isCurrentAttempt: (list: OrderList, attempt: number) => boolean
  setInbox: (message: Message | null) => void
  setBoxes: (message: Message | null) => void
  setArchiveTapes: (boxKey: string, message: Message | null) => void
}

/**
 * Session ownership for sortable-list results and attempts. Both outlive view
 * switches: only a later reorder of the same list supersedes its result.
 * Keep one confirmed arrangement only while saves overlap: nested optimism is
 * not a rollback base. Main applies reorders in the order they arrive, so each
 * successful reply, superseded or not, advances it to that attempt's order;
 * every settlement retires its attempt.
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
  finishAttempt: (list, attempt, saved) => set((state) => {
    const previous = state.pending[list]
    if (!previous?.active.has(attempt)) return state
    const active = new Set(previous.active)
    active.delete(attempt)
    const pending = { ...state.pending }
    const confirmed = saved ? new Map([...previous.confirmed, ...orders(saved)]) : previous.confirmed
    if (active.size === 0) delete pending[list]
    else pending[list] = { active, confirmed }
    return { pending }
  }),
  confirmedOrder: (list) => [...(get().pending[list]?.confirmed ?? [])].map(([id, order]) => ({ id, order })),
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
