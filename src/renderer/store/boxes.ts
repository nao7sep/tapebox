import { create } from 'zustand'
import type { Box } from '@shared/domain'

/**
 * Renderer mirror of the archive boxes, hydrated at startup and kept in sync by
 * the boxes:changed event. Box membership and order of individual tapes live on
 * the tapes themselves (see tapeOrder); this store is just the box list.
 */
type BoxesState = {
  boxes: Box[]
  setBoxes: (boxes: Box[]) => void
}

export const useBoxesStore = create<BoxesState>((set) => ({
  boxes: [],
  setBoxes: (boxes) => set({ boxes }),
}))
