import { create } from 'zustand'

type SelectionState = {
  selectedId: string | null
  select: (id: string | null) => void
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedId: null,
  select: (selectedId) => set({ selectedId }),
}))
