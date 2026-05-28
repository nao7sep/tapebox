import { create } from 'zustand'

type EnumState = {
  active: { sessionId: string; sourceTitle: string | null } | null
  open: (sessionId: string, sourceTitle: string | null) => void
  close: () => void
}

export const useEnumerationStore = create<EnumState>((set) => ({
  active: null,
  open: (sessionId, sourceTitle) => set({ active: { sessionId, sourceTitle } }),
  close: () => set({ active: null }),
}))
