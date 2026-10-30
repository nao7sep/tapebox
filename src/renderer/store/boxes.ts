import { create } from 'zustand'
import type { Box } from '@shared/domain'

/**
 * Renderer mirror of the Shelf boxes, hydrated at startup and kept in sync by
 * the boxes:changed event. Box membership and order of individual tapes live on
 * the tapes themselves (see tapeOrder); this store also owns the inline rename draft across Archive/Inbox navigation.
 */
type BoxesState = {
  collection: object
  boxes: Box[]
  editingId: string | null
  draftName: string
  pendingRenames: number
  setBoxes: (boxes: Box[]) => void
}

export const useBoxesStore = create<BoxesState>((set) => ({
  collection: {},
  boxes: [],
  editingId: null,
  draftName: '',
  pendingRenames: 0,
  setBoxes: (boxes) => set({ boxes }),
}))
