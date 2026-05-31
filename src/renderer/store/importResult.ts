import { create } from 'zustand'
import type { ImportResult } from '@shared/ipc-contract'

/**
 * Holds the outcome of the most recent import for a blocking results modal.
 * Producers (the drop zone, the file picker) call show(); a single
 * <ImportResultModal> mounted at the app root renders it and calls clear() on
 * dismiss. Unlike the transient notice store there's no TTL — the user must
 * acknowledge what entered the library and what didn't.
 */
type ImportResultState = {
  result: ImportResult | null
  show: (result: ImportResult) => void
  clear: () => void
}

export const useImportResultStore = create<ImportResultState>((set) => ({
  result: null,
  show: (result) => set({ result }),
  clear: () => set({ result: null }),
}))
