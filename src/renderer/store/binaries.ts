import { create } from 'zustand'
import type { BinaryName, BinaryStatus } from '@shared/ipc-contract'

type Phase = 'download' | 'verify' | 'install'

type BinariesState = {
  statuses: BinaryStatus[]
  progress: Partial<Record<BinaryName, { percent: number; phase: Phase }>>
  setStatuses: (s: BinaryStatus[]) => void
  setProgress: (name: BinaryName, percent: number, phase: Phase) => void
  markReady: (name: BinaryName, version: string) => void
}

export const useBinariesStore = create<BinariesState>((set) => ({
  statuses: [],
  progress: {},
  setStatuses: (statuses) => set({ statuses }),
  setProgress: (name, percent, phase) =>
    set((state) => ({ progress: { ...state.progress, [name]: { percent, phase } } })),
  markReady: (name, version) =>
    set((state) => {
      const nextProgress = { ...state.progress }
      delete nextProgress[name]
      return {
        progress: nextProgress,
        statuses: state.statuses.map((s) =>
          s.name === name ? { ...s, installedVersion: version, isUpdating: false } : s,
        ),
      }
    }),
}))
