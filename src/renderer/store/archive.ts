import { create } from 'zustand'

/**
 * Archive organizer view state.
 *   - selectedBoxId: which box's tapes fill the lower list (null = Unboxed).
 *     Keyboard nav / removal operate over them. Selecting a box clears the search.
 *   - query: free-text search across ALL archived tapes; when non-empty the lower
 *     list shows matches (read-only) instead of the selected box.
 */
type ArchiveState = {
  selectedBoxId: string | null
  selectBox: (id: string | null) => void
  query: string
  setQuery: (q: string) => void
  // A one-shot request to focus the archive search box, set by the "/" shortcut and
  // consumed (focus, then clear) by the search input. Lets a global key focus an
  // input it doesn't own without prop-drilling a ref up to the keyboard layer.
  pendingSearchFocus: boolean
  setPendingSearchFocus: (v: boolean) => void
}

export const useArchiveStore = create<ArchiveState>((set) => ({
  selectedBoxId: null,
  selectBox: (selectedBoxId) => set({ selectedBoxId, query: '' }),
  query: '',
  setQuery: (query) => set({ query }),
  pendingSearchFocus: false,
  setPendingSearchFocus: (pendingSearchFocus) => set({ pendingSearchFocus }),
}))
