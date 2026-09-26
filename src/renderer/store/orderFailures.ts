import { create } from 'zustand'
import type { Message } from '@shared/i18n/translate'

type OrderFailuresState = {
  inbox: Message | null
  boxes: Message | null
  archiveTapes: Record<string, Message | undefined>
  setInbox: (message: Message | null) => void
  setBoxes: (message: Message | null) => void
  setArchiveTapes: (boxKey: string, message: Message | null) => void
}

/**
 * Persistent presentation state for the three sortable lists. These results
 * outlive view switches, while their explicit slots keep independent list
 * failures from replacing one another or drifting to app-wide chrome.
 */
export const useOrderFailuresStore = create<OrderFailuresState>((set) => ({
  inbox: null,
  boxes: null,
  archiveTapes: {},
  setInbox: (inbox) => set({ inbox }),
  setBoxes: (boxes) => set({ boxes }),
  setArchiveTapes: (boxKey, message) => set((state) => {
    const archiveTapes = { ...state.archiveTapes }
    if (message === null) delete archiveTapes[boxKey]
    else archiveTapes[boxKey] = message
    return { archiveTapes }
  }),
}))
