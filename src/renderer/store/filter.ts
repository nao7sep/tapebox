import { create } from 'zustand'

export type Filter = 'shelf' | 'archived'

type FilterState = {
  filter: Filter
  setFilter: (f: Filter) => void
}

export const useFilterStore = create<FilterState>((set) => ({
  filter: 'shelf',
  setFilter: (filter) => set({ filter }),
}))
