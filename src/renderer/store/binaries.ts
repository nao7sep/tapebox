import { create } from 'zustand'
import type { BinaryName, BinaryStatus } from '@shared/ipc-contract'

type Phase = 'download' | 'verify' | 'install'

type BinariesState = {
  statuses: BinaryStatus[]
  progress: Partial<Record<BinaryName, { percent: number; phase: Phase }>>
  /** The shared install/update modal. Always dismissible (Esc / backdrop / ✕). */
  modalOpen: boolean
  /** An update check is in flight (startup auto-check or modal-opened check). */
  checking: boolean
  setStatuses: (s: BinaryStatus[]) => void
  setProgress: (name: BinaryName, percent: number, phase: Phase) => void
  markReady: (name: BinaryName, version: string) => void
  setChecking: (checking: boolean) => void
  openModal: () => void
  closeModal: () => void
}

export const useBinariesStore = create<BinariesState>((set) => ({
  statuses: [],
  progress: {},
  modalOpen: false,
  checking: false,
  setStatuses: (statuses) => set({ statuses }),
  setChecking: (checking) => set({ checking }),
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

/**
 * True when every installed binary has a known latest version — i.e. a check
 * actually resolved. False covers both "auto-check off / never ran" and "the
 * check failed", since a failed lookup leaves latestKnownVersion null.
 */
export function updatesChecked(statuses: BinaryStatus[]): boolean {
  const installed = statuses.filter((s) => s.installedVersion !== null)
  return installed.length > 0 && installed.every((s) => s.latestKnownVersion !== null)
}
