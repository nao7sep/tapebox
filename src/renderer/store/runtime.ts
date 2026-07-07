import { create } from 'zustand'
import type { RuntimeInfo } from '@shared/ipc-contract'

type RuntimeState = {
  info: RuntimeInfo | null
  setInfo: (info: RuntimeInfo) => void
}

export const useRuntimeStore = create<RuntimeState>((set) => ({
  info: null,
  setInfo: (info) => set({ info }),
}))
