import { create } from 'zustand'

export type TapeAction =
  | 'archive'
  | 'unarchive'
  | 'placement'
  | 'retry'
  | 'cancel'
  | 'open'
  | 'reveal'
  | 'open-url'
  | 'copy-url'
  | 'remove'

type TapeActionResultsState = {
  byTape: Record<string, Partial<Record<TapeAction, string>> | undefined>
  setResult: (tapeId: string, action: TapeAction, message: string | null) => void
  clearTape: (tapeId: string) => void
}

/**
 * Retained presentation for direct actions on one tape. Results are keyed by
 * both tape and operation so a failed reveal cannot erase an unresolved archive
 * failure, and a result follows its tape between Inbox, Archive, and search.
 */
export const useTapeActionResultsStore = create<TapeActionResultsState>((set) => ({
  byTape: {},
  setResult: (tapeId, action, message) => set((state) => {
    const byTape = { ...state.byTape }
    const tapeResults = { ...byTape[tapeId] }
    if (message === null) delete tapeResults[action]
    else tapeResults[action] = message
    if (Object.keys(tapeResults).length === 0) delete byTape[tapeId]
    else byTape[tapeId] = tapeResults
    return { byTape }
  }),
  clearTape: (tapeId) => set((state) => {
    if (!state.byTape[tapeId]) return state
    const byTape = { ...state.byTape }
    delete byTape[tapeId]
    return { byTape }
  }),
}))
