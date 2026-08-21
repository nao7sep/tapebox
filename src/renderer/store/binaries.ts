import { create } from 'zustand'
import type {
  BinaryCheckFailure,
  BinaryCheckResult,
  BinaryName,
  BinaryStatus,
} from '@shared/ipc-contract'
import {
  deriveStatus,
  rollupRole,
  type DependencyFacts,
  type DerivedStatus,
  type Role,
} from '@shared/binary-status'

// A binary needs the tools surface's attention (drives the blocking add-URL gate
// and the first-run auto-open) only when it is not installed — the one sanctioned
// interruption. An available update surfaces passively in the status bar, never by
// blocking.

type Phase = 'download' | 'verify' | 'install'

type BinariesState = {
  statuses: BinaryStatus[]
  progress: Partial<Record<BinaryName, { percent: number; phase: Phase }>>
  /** The shared install/update modal. Always dismissible (Esc / backdrop / ✕). */
  modalOpen: boolean
  /** An update check is in flight (startup auto-check or modal-opened check). */
  checking: boolean
  /** Failures from the most recently completed launch/manual check in this session. */
  checkFailures: BinaryCheckFailure[] | null
  setStatuses: (s: BinaryStatus[]) => void
  setProgress: (name: BinaryName, percent: number, phase: Phase) => void
  clearProgress: (name: BinaryName) => void
  setChecking: (checking: boolean) => void
  setCheckFailures: (failures: BinaryCheckFailure[] | null) => void
  openModal: () => void
  closeModal: () => void
}

export const useBinariesStore = create<BinariesState>((set) => ({
  statuses: [],
  progress: {},
  modalOpen: false,
  checking: false,
  checkFailures: null,
  setStatuses: (statuses) => set({ statuses }),
  setChecking: (checking) => set({ checking }),
  setCheckFailures: (checkFailures) => set({ checkFailures }),
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

/** Apply one completed manual or launch check as a single session-state result. */
export function applyBinaryCheckResult(result: BinaryCheckResult): void {
  useBinariesStore.setState({
    statuses: result.statuses,
    checkFailures: result.failures,
  })
}

// ── Derivation: one shared rule both surfaces (status bar + modal) call ──────

/** Adapt the wire status to the derivation's fact shape (latestKnownVersion is the
 *  "desired" version in the model's vocabulary). `present` and `installedVersion`
 *  both come from main's read of the artifact, so they cannot disagree. */
export function factsOf(s: BinaryStatus): DependencyFacts {
  return {
    present: s.present,
    installedVersion: s.installedVersion,
    desiredVersion: s.latestKnownVersion,
    lastCheckedAtUtc: s.lastCheckedAtUtc,
  }
}

export function derivedOf(s: BinaryStatus): DerivedStatus {
  return deriveStatus(factsOf(s))
}

/**
 * True once every managed binary is present — the blocking add-URL gate. A binary
 * that is not installed blocks downloads until the user provisions it.
 */
export function allBinariesUsable(statuses: BinaryStatus[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s.present)
}

/**
 * A required tool is missing — the one condition that auto-opens the tools surface
 * at first run (regardless of the check toggle). An available update never blocks;
 * it surfaces passively in the status bar.
 */
export function binariesNeedAttention(statuses: BinaryStatus[]): boolean {
  return statuses.some((s) => derivedOf(s).state === 'not-installed')
}

export type ToolsSummary = { role: Role; text: string; actionable: boolean }

/**
 * The single roll-up for the status bar: the worst role across all binaries
 * (warning > info > none) with a representative message. Pure, so the status bar
 * renders only what this returns. Quiet (role 'none') when every binary is Up to
 * date — the convention's default silence. Derived states carry no error role
 * (there is no faulted/check-failed state), so 'error' never arises here.
 */
export function summarizeBinaries(statuses: BinaryStatus[]): ToolsSummary {
  const derived = statuses.map(derivedOf)
  const role = rollupRole(derived.map((d) => d.role))

  const count = (pred: (d: DerivedStatus) => boolean) => derived.filter(pred).length
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

  if (role === 'warning') {
    const absent = count((d) => d.state === 'not-installed')
    if (absent > 0) return { role, text: `${plural(absent, "tool isn’t", "tools aren’t")} installed`, actionable: true }
    return { role, text: `${plural(count((d) => d.state === 'update-available'), 'update', 'updates')} available`, actionable: true }
  }
  if (role === 'info') {
    // A present tool whose own version could not be read is a different story from
    // one that simply hasn't been checked: the first needs the user to re-acquire
    // it, the second only needs a check. Both are informational, so the roll-up
    // says which one it is rather than defaulting to the quieter wording.
    const unreadable = statuses.filter((s) => s.present && s.installedVersion === null).length
    if (unreadable > 0) {
      return { role, text: `${plural(unreadable, 'tool', 'tools')} couldn’t be read`, actionable: true }
    }
    return { role, text: 'Updates not checked', actionable: false }
  }
  return { role: 'none', text: 'Tools ready', actionable: false }
}
