import { create } from 'zustand'
import type { ImportResult } from '@shared/ipc-contract'

export interface ImportAttempt {
  operationKey: string
  entryKey: string
}

/**
 * Holds the most recent non-successful import outcome. The tape collection renders
 * it as a persistent nonmodal status surface for both picker and drop entry paths.
 * A later full success leaves an unresolved result in place until dismissal.
 */
type ImportResultState = {
  result: ImportResult | null
  operationKey: string | null
  settle: (attempt: ImportAttempt, result: ImportResult | null) => void
  clear: () => void
}

export const useImportResultStore = create<ImportResultState>((set) => ({
  result: null,
  operationKey: null,
  settle: (attempt, result) => set((current) => {
    if (result !== null) return { result, operationKey: attempt.operationKey }
    if (
      current.operationKey === attempt.operationKey ||
      current.operationKey === attempt.entryKey
    ) return { result: null, operationKey: null }
    return current
  }),
  clear: () => set({ result: null, operationKey: null }),
}))
