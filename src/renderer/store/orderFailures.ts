import { create } from 'zustand'

type OrderFailuresState = {
  inbox: string | null
  boxes: string | null
  archiveTapes: Record<string, string | undefined>
  setInbox: (message: string | null) => void
  setBoxes: (message: string | null) => void
  setArchiveTapes: (boxKey: string, message: string | null) => void
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
