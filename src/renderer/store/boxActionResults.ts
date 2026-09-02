import { create } from 'zustand'

export type BoxAction = 'create' | 'rename' | 'delete'

type BoxActionResultsState = {
  results: Partial<Record<BoxAction, string>>
  setResult: (action: BoxAction, message: string | null) => void
}

/** Retained results owned by the archive's box list, independent by command. */
export const useBoxActionResultsStore = create<BoxActionResultsState>((set) => ({
  results: {},
  setResult: (action, message) => set((state) => {
    const results = { ...state.results }
    if (message === null) delete results[action]
    else results[action] = message
    return { results }
  }),
}))
