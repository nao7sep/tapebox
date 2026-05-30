import { create } from 'zustand'

/**
 * Which archive box is selected in the organizer's box list — its tapes fill the
 * lower list, and keyboard nav / removal operate over them. null = the Ungrouped
 * box (archived tapes with no groupId), which is the default selection.
 */
type ArchiveState = {
  selectedGroupId: string | null
  selectGroup: (id: string | null) => void
}

export const useArchiveStore = create<ArchiveState>((set) => ({
  selectedGroupId: null,
  selectGroup: (selectedGroupId) => set({ selectedGroupId }),
}))
