import { create } from 'zustand'

/**
 * Archive organizer view state.
 *   - selectedGroupId: which box's tapes fill the lower list (null = Ungrouped).
 *     Keyboard nav / removal operate over them. Selecting a box clears the search.
 *   - query: free-text search across ALL archived tapes; when non-empty the lower
 *     list shows matches (read-only) instead of the selected box.
 */
type ArchiveState = {
  selectedGroupId: string | null
  selectGroup: (id: string | null) => void
  query: string
  setQuery: (q: string) => void
}

export const useArchiveStore = create<ArchiveState>((set) => ({
  selectedGroupId: null,
  selectGroup: (selectedGroupId) => set({ selectedGroupId, query: '' }),
  query: '',
  setQuery: (query) => set({ query }),
}))
