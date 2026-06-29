import { create } from 'zustand'
import type { BinaryName, BinaryStatus } from '@shared/ipc-contract'
import {
  deriveStatus,
  rollupRole,
  type DependencyFacts,
  type DerivedStatus,
  type Role,
} from '@shared/binary-status'

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
  clearProgress: (name: BinaryName) => void
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
  clearProgress: (name) =>
    set((state) => {
      const next = { ...state.progress }
      delete next[name]
      return { progress: next }
    }),
  openModal: () => set({ modalOpen: true }),
  closeModal: () => set({ modalOpen: false }),
}))

// ── Derivation: one shared rule both surfaces (status bar + modal) call ──────

/** Adapt the wire status to the derivation's fact shape (latestKnownVersion is the
 *  "desired" version in the model's vocabulary). */
export function factsOf(s: BinaryStatus): DependencyFacts {
  return {
    present: s.present,
    integrity: s.integrity,
    installedVersion: s.installedVersion,
    desiredVersion: s.latestKnownVersion,
    lastCheckedAtUtc: s.lastCheckedAtUtc,
    checkError: s.checkError,
    faultError: s.faultError,
  }
}

export function derivedOf(s: BinaryStatus): DerivedStatus {
  return deriveStatus(factsOf(s))
}

/**
 * True once every managed binary is present and usable — Provisioned or a
 * user-supplied Unmanaged copy. Drives the blocking gate: anything Absent or
 * Faulted means the tools surface should be presented.
 */
export function allBinariesUsable(statuses: BinaryStatus[]): boolean {
  return (
    statuses.length > 0 &&
    statuses.every((s) => {
      const { lifecycle } = derivedOf(s)
      return lifecycle === 'provisioned' || lifecycle === 'unmanaged'
    })
  )
}

/**
 * Tools that warrant the surface auto-opening at startup: Absent, Faulted, or Stale
 * (an available update) — full mumbler parity. Unchecked/Unmanaged are benign and
 * never auto-open. Gated by the check-updates setting at the call site.
 */
export function binariesNeedAttention(statuses: BinaryStatus[]): boolean {
  return statuses.some((s) => {
    const { lifecycle, currency } = derivedOf(s)
    return lifecycle === 'absent' || lifecycle === 'faulted' || currency === 'stale'
  })
}

/** Names of the Absent tools — the set auto-download provisions (missing only). */
export function absentBinaries(statuses: BinaryStatus[]): BinaryName[] {
  return statuses.filter((s) => derivedOf(s).lifecycle === 'absent').map((s) => s.name)
}

export type ToolsSummary = { role: Role; text: string; actionable: boolean }

/**
 * The single roll-up for the status bar: the worst role across all binaries
 * (error > warning > info > none) with a representative message. Pure, so the
 * status bar renders only what this returns. Quiet (role 'none') when every binary
 * is Provisioned + Current — the convention's default silence.
 */
export function summarizeBinaries(statuses: BinaryStatus[]): ToolsSummary {
  const derived = statuses.map(derivedOf)
  const role = rollupRole(derived.map((d) => d.role))

  const count = (pred: (d: DerivedStatus) => boolean) => derived.filter(pred).length
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

  if (role === 'error') {
    return { role, text: `${plural(count((d) => d.role === 'error'), 'tool needs', 'tools need')} attention`, actionable: true }
  }
  if (role === 'warning') {
    const absent = count((d) => d.lifecycle === 'absent')
    if (absent > 0) return { role, text: `${plural(absent, "tool isn’t", "tools aren’t")} installed`, actionable: true }
    return { role, text: `${plural(count((d) => d.currency === 'stale'), 'update', 'updates')} available`, actionable: true }
  }
  if (role === 'info') {
    const unchecked = count((d) => d.currency === 'unchecked')
    if (unchecked > 0) return { role, text: 'Updates not checked', actionable: false }
    return { role, text: 'Using your own copy', actionable: false }
  }
  return { role: 'none', text: 'Tools ready', actionable: false }
}
