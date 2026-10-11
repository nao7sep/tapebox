import { create } from 'zustand'
import type { Message } from '@shared/i18n/translate'

/** The Inbox, box list, and one archived tape list settle independently. */
export type OrderList = 'inbox' | 'boxes' | `archive:${string}`

type OrderFailuresState = {
  inbox: Message | null
  boxes: Message | null
  archiveTapes: Record<string, Message | undefined>
  attempts: Partial<Record<OrderList, number>>
  beginAttempt: (list: OrderList) => number
  isCurrentAttempt: (list: OrderList, attempt: number) => boolean
  setInbox: (message: Message | null) => void
  setBoxes: (message: Message | null) => void
  setArchiveTapes: (boxKey: string, message: Message | null) => void
}

/**
 * Session ownership for sortable-list results and attempts. Both outlive view
 * switches: only a later reorder of the same list supersedes its settlement.
 * Whole-row main updates can carry old order values during a pending write, so
 * rendered numeric equality cannot identify which reorder still owns a result.
 */
export const useOrderFailuresStore = create<OrderFailuresState>((set, get) => ({
  inbox: null,
  boxes: null,
  archiveTapes: {},
  attempts: {},
  beginAttempt: (list) => {
    const attempt = (get().attempts[list] ?? 0) + 1
    set((state) => ({ attempts: { ...state.attempts, [list]: attempt } }))
    return attempt
  },
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
