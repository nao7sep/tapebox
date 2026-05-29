import { create } from 'zustand'
import type { BinaryName, BinaryStatus } from '@shared/ipc-contract'

type Phase = 'download' | 'verify' | 'install'

type BinariesState = {
  statuses: BinaryStatus[]
  progress: Partial<Record<BinaryName, { percent: number; phase: Phase }>>
  /** The shared install/update modal. Always dismissible (Esc / backdrop / ✕). */
  modalOpen: boolean
  setStatuses: (s: BinaryStatus[]) => void
  setProgress: (name: BinaryName, percent: number, phase: Phase) => void
  markReady: (name: BinaryName, version: string) => void
  openModal: () => void
  closeModal: () => void
}

export const useBinariesStore = create<BinariesState>((set) => ({
  statuses: [],
  progress: {},
  modalOpen: false,
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
  openModal: () => set({ modalOpen: true }),
  closeModal: () => set({ modalOpen: false }),
}))

/** True once every managed binary is installed. Empty status list = not yet known. */
export function allBinariesInstalled(statuses: BinaryStatus[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s.installedVersion !== null)
}

/** Installed binaries whose latest known upstream version differs from the installed one. */
export function binariesWithUpdate(statuses: BinaryStatus[]): BinaryStatus[] {
  return statuses.filter(
    (s) =>
      s.installedVersion !== null &&
      s.latestKnownVersion !== null &&
      s.latestKnownVersion !== s.installedVersion,
  )
}
