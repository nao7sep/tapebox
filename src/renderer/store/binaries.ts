import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type {
  BinaryCheckFailure,
  BinaryName,
  BinaryStatus,
  BinaryUpdateResult,
} from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import { presentFailure } from '@renderer/lib/presentFailure'
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
type ActiveAcquisition = { operationId: string; cancelling: boolean }
type TerminalOutcome = 'cancelled'

type BinariesState = {
  statuses: BinaryStatus[]
  progress: Partial<Record<BinaryName, { percent: number; phase: Phase }>>
  /** Application-owned attempts. Their lifetime is independent of the modal. */
  active: Partial<Record<BinaryName, ActiveAcquisition>>
  /** Terminal acquisition/cancellation failures retained until retry. */
  errors: Partial<Record<BinaryName, string>>
  /** Non-error terminal outcomes whose stable artifact facts are unchanged. */
  terminalOutcomes: Partial<Record<BinaryName, TerminalOutcome>>
  /** Per-row application revision used to keep a concurrent check snapshot from
   * replacing a newer acquisition result. */
  statusRevisions: Partial<Record<BinaryName, number>>
  /** The shared install/update modal. Always dismissible (Esc / backdrop / ✕). */
  modalOpen: boolean
  /** An update check is in flight (startup auto-check or modal-opened check). */
  checking: boolean
  checkCancelling: boolean
  checkError: string | null
  /** Failures from the most recently completed launch/manual check in this session. */
  checkFailures: BinaryCheckFailure[] | null
  setStatuses: (s: BinaryStatus[]) => void
  setProgress: (name: BinaryName, operationId: string, percent: number, phase: Phase) => void
  install: (name: BinaryName) => Promise<void>
  cancelInstall: (name: BinaryName) => Promise<void>
  checkUpdates: () => Promise<void>
  cancelCheck: () => Promise<void>
  openModal: () => void
  closeModal: () => void
}

function replaceStatus(statuses: BinaryStatus[], next: BinaryStatus): BinaryStatus[] {
  const index = statuses.findIndex((status) => status.name === next.name)
  if (index < 0) return [...statuses, next]
  const replacement = [...statuses]
  replacement[index] = next
  return replacement
}

function mergeCheckedStatus(
  statuses: BinaryStatus[],
  checked: BinaryStatus,
  artifactChanged: boolean,
): BinaryStatus[] {
  if (!artifactChanged) return replaceStatus(statuses, checked)
  const current = statuses.find((status) => status.name === checked.name)
  if (!current) return [...statuses, checked]
  const currentCheckedAt = current.lastCheckedAtUtc ? Date.parse(current.lastCheckedAtUtc) : -1
  const nextCheckedAt = checked.lastCheckedAtUtc ? Date.parse(checked.lastCheckedAtUtc) : -1
  if (nextCheckedAt < currentCheckedAt) return statuses
  // An acquisition settled while this check was running. Keep its newer artifact
  // truth, but accept the check's newer network knowledge; neither snapshot alone
  // owns both halves after those concurrent boundaries.
  return replaceStatus(statuses, {
    ...current,
    latestKnownVersion: checked.latestKnownVersion,
    lastCheckedAtUtc: checked.lastCheckedAtUtc,
  })
}

function withoutKey<T>(record: Partial<Record<BinaryName, T>>, name: BinaryName) {
  const next = { ...record }
  delete next[name]
  return next
}

function applyTerminal(
  state: BinariesState,
  name: BinaryName,
  result: BinaryUpdateResult,
): Partial<BinariesState> | null {
  if (state.active[name]?.operationId !== result.operationId) return null
  const errors = withoutKey(state.errors, name)
  const terminalOutcomes = withoutKey(state.terminalOutcomes, name)
  if (result.outcome === 'failed') errors[name] = result.error
  if (result.outcome === 'cancelled') terminalOutcomes[name] = 'cancelled'
  return {
    statuses: replaceStatus(state.statuses, result.status),
    active: withoutKey(state.active, name),
    progress: withoutKey(state.progress, name),
    errors,
    terminalOutcomes,
    statusRevisions: {
      ...state.statusRevisions,
      [name]: (state.statusRevisions[name] ?? 0) + 1,
    },
  }
}

export const useBinariesStore = create<BinariesState>((set, get) => ({
  statuses: [],
  progress: {},
  active: {},
  errors: {},
  terminalOutcomes: {},
  statusRevisions: {},
  modalOpen: false,
  checking: false,
  checkCancelling: false,
  checkError: null,
  checkFailures: null,
  setStatuses: (statuses) => set({ statuses }),
  setProgress: (name, operationId, percent, phase) =>
    set((state) =>
      state.active[name]?.operationId === operationId
        ? { progress: { ...state.progress, [name]: { percent, phase } } }
        : state,
    ),
  install: async (name) => {
    if (get().active[name]) return
    const operationId = nanoid(12)
    set((state) => ({
      active: { ...state.active, [name]: { operationId, cancelling: false } },
      progress: withoutKey(state.progress, name),
      errors: withoutKey(state.errors, name),
      terminalOutcomes: withoutKey(state.terminalOutcomes, name),
    }))
    try {
      const result = await ipcInvoke('binaries:update', { name, operationId })
      set((state) => applyTerminal(state, name, result) ?? state)
    } catch (error) {
      // A bridge/process failure is the only way an update lacks a typed terminal
      // payload. Preserve the prior facts, but still settle this exact attempt and
      // retain the interface failure independently of the modal.
      set((state) => {
        if (state.active[name]?.operationId !== operationId) return state
        return {
          active: withoutKey(state.active, name),
          progress: withoutKey(state.progress, name),
          errors: { ...state.errors, [name]: presentFailure(error, `${name} could not be installed or updated. The existing tool, if any, is unchanged; try again.`, 'managed tool update failed') },
          terminalOutcomes: withoutKey(state.terminalOutcomes, name),
        }
      })
    }
  },
  cancelInstall: async (name) => {
    const active = get().active[name]
    if (!active || active.cancelling) return
    set((state) =>
      state.active[name]?.operationId === active.operationId
        ? {
            active: {
              ...state.active,
              [name]: { ...active, cancelling: true },
            },
          }
        : state,
    )
    try {
      const result = await ipcInvoke('binaries:cancelUpdate', {
        name,
        operationId: active.operationId,
      })
      if (result.outcome === 'not-running') {
        set((state) =>
          state.active[name]?.operationId === active.operationId
            ? {
                active: {
                  ...state.active,
                  [name]: { ...active, cancelling: false },
                },
              }
            : state,
        )
      }
    } catch (error) {
      set((state) =>
        state.active[name]?.operationId === active.operationId
          ? {
              active: {
                ...state.active,
                [name]: { ...active, cancelling: false },
              },
              errors: { ...state.errors, [name]: presentFailure(error, `${name} cancellation could not be confirmed. Wait for the operation to settle, then try again.`, 'managed tool cancellation failed') },
            }
          : state,
      )
    }
  },
  checkUpdates: async () => {
    if (get().checking) return
    const baseline = { ...get().statusRevisions }
    set({ checking: true, checkCancelling: false, checkError: null, checkFailures: null })
    try {
      const result = await ipcInvoke('binaries:checkUpdates')
      if (result.outcome === 'completed') {
        set((state) => ({
          statuses: result.statuses.reduce(
            (statuses, status) =>
              mergeCheckedStatus(
                statuses,
                status,
                (state.statusRevisions[status.name] ?? 0) !== (baseline[status.name] ?? 0),
              ),
            state.statuses,
          ),
          checkFailures: result.failures,
        }))
      }
    } catch (error) {
      set({ checkError: presentFailure(error, 'Tool updates could not be checked. Installed tools are unchanged; try again later.', 'managed tool update check failed') })
    } finally {
      set({ checking: false, checkCancelling: false })
    }
  },
  cancelCheck: async () => {
    if (!get().checking || get().checkCancelling) return
    set({ checkCancelling: true })
    try {
      const result = await ipcInvoke('binaries:cancelCheck')
      if (result.outcome === 'not-running') set({ checkCancelling: false })
    } catch (error) {
      set({ checkCancelling: false, checkError: presentFailure(error, 'The update check could not be cancelled yet. Wait for it to finish.', 'managed tool check cancellation failed') })
    }
  },
  openModal: () => set({ modalOpen: true }),
  closeModal: () => set({ modalOpen: false }),
}))

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
  return deriveStatus(factsOf(s), s.name !== 'deno')
}

/**
 * True once the two tools every download needs are present. Deno remains optional:
 * yt-dlp uses it only for sites that need a JavaScript runtime.
 */
export function requiredBinariesUsable(statuses: BinaryStatus[]): boolean {
  return (['yt-dlp', 'ffmpeg'] as const).every(
    (name) => statuses.find((status) => status.name === name)?.present === true,
  )
}

/**
 * A required tool is missing — the one condition that auto-opens the tools surface
 * at first run (regardless of the check toggle). An available update never blocks;
 * it surfaces passively in the status bar.
 */
export function binariesNeedAttention(statuses: BinaryStatus[]): boolean {
  return statuses.some((s) => s.name !== 'deno' && derivedOf(s).state === 'not-installed')
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
    if (statuses.some((s) => s.name === 'deno' && !s.present)) {
      return { role, text: 'Optional tool isn’t installed', actionable: true }
    }
    return { role, text: 'Updates not checked', actionable: false }
  }
  return { role: 'none', text: 'Tools ready', actionable: false }
}
