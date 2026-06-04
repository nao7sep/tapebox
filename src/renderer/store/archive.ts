import { create } from 'zustand'

/**
 * Archive organizer view state.
 *   - selectedBoxId: which box's tapes fill the lower list (null = Loose).
 *     Keyboard nav / removal operate over them. Selecting a box clears the search.
 *   - query: free-text search across ALL archived tapes; when non-empty the lower
 *     list shows matches (read-only) instead of the selected box.
 */
type ArchiveState = {
  selectedBoxId: string | null
  selectBox: (id: string | null) => void
  query: string
  setQuery: (q: string) => void
}

export const useArchiveStore = create<ArchiveState>((set) => ({
  selectedBoxId: null,
  selectBox: (selectedBoxId) => set({ selectedBoxId, query: '' }),
  query: '',
  setQuery: (query) => set({ query }),
}))
