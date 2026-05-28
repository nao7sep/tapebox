import { create } from 'zustand'

export type Filter = 'inbox' | 'archived' | 'failed' | 'all'

type FilterState = {
  filter: Filter
  setFilter: (f: Filter) => void
}

export const useFilterStore = create<FilterState>((set) => ({
  filter: 'inbox',
  setFilter: (filter) => set({ filter }),
}))
