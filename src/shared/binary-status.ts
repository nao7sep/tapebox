/**
 * The managed-dependency state model (managed-runtime-dependencies-conventions).
 *
 * A managed binary's state is one of four, derived from scanned presence plus two
 * version facts by `deriveStatus` — one pure rule with no filesystem probe, no
 * `--version` call, no network. Both surfaces (status bar + tools modal) render its
 * output and nothing else (Separation-of-Concerns rule #4 — the state decision is
 * extracted from the view so it can be unit-tested, and that test is what keeps the
 * honest-state principle honest rather than aspirational).
 *
 * The honest-state principle: never report a state the facts do not support.
 * "Up to date" requires a check that actually succeeded — with checks off, or before
 * any check, a present binary reads "installed-unchecked", never "up-to-date". A
 * failed check writes nothing, so it can never masquerade as fresh. There is no
 * faulted state: a damaged file fails loudly when used and is fixed by installing
 * again; and there is no "unmanaged" state — a user-placed binary is read the same
 * way as one the app installed, because the installed version comes from the
 * artifact rather than from a record of having installed it.
 *
 * Lives in @shared (no node imports) so the renderer — typechecked without
 * @types/node — derives state through the very same rule the main process records.
 */

/** The four states a managed binary can be in. */
export type DependencyState =
  | 'not-installed'
  | 'update-available'
  | 'up-to-date'
  | 'installed-unchecked'

/** The semantic roles a surface renders through; the theme owns the colour. */
export type Role = 'none' | 'info' | 'warning' | 'error'

/**
 * The recorded facts the derivation reads. `present` and `installedVersion` are
 * both gathered from the ARTIFACT by the fact-gathering step in main — one
 * filesystem scan and one read of the binary itself — so neither is persisted and
 * the two cannot disagree. `desiredVersion` (the latest a check resolved) and
 * `lastCheckedAtUtc` are the persisted network facts.
 *
 * A null `installedVersion` on a PRESENT binary means its version could not be
 * read (the probe failed, or a sidecar-tracked binary has none). That is not the
 * same as absent and must never read as up to date — `stateOf` keeps it at
 * `installed-unchecked`, and the surface offers the re-acquire that fixes it.
 */
export type DependencyFacts = {
  present: boolean
  installedVersion: string | null
  desiredVersion: string | null
  lastCheckedAtUtc: string | null
}

export type DerivedStatus = {
  state: DependencyState
  role: Role
}

function stateOf(f: DependencyFacts): DependencyState {
  if (!f.present) return 'not-installed'
  // "Checked" needs a successful check (lastCheckedAtUtc set — a failed check writes
  // nothing) AND both versions to compare. A present copy whose installed version
  // could not be read can't be compared, so it stays unchecked rather than being
  // dressed up as current.
  const checked =
    f.lastCheckedAtUtc !== null && f.desiredVersion !== null && f.installedVersion !== null
  if (!checked) return 'installed-unchecked'
  return f.desiredVersion === f.installedVersion ? 'up-to-date' : 'update-available'
}

// yt-dlp and ffmpeg are required throughout the download flow; Deno is optional
// outside the sites whose yt-dlp extractor needs a JavaScript runtime. Missing is
// therefore warning or informational according to the current scope.
function roleOf(state: DependencyState, required: boolean): Role {
  switch (state) {
    case 'not-installed':
      return required ? 'warning' : 'info'
    case 'update-available':
      return 'warning'
    case 'installed-unchecked':
      return 'info'
    case 'up-to-date':
      return 'none'
  }
}

/**
 * Compute the displayed state of one managed binary from its recorded facts. Pure
 * and total — a function of the persisted facts alone. Transient operation status (a
 * running install's progress, a just-failed action) is layered over this by the
 * surface, never folded into the persisted state.
 */
export function deriveStatus(facts: DependencyFacts, required = true): DerivedStatus {
  const state = stateOf(facts)
  return { state, role: roleOf(state, required) }
}

/**
 * The persisted-fact transition an operation applies to a binary's facts entry.
 * Pure (no I/O) so the honest-state rules are unit-tested directly, with the manager
 * reduced to gathering the outcome and persisting it. Typed against the persisted
 * subset rather than the full schema, so this stays node-/zod-free for the renderer
 * bundle.
 *
 * There is no transition for a failed check or a failed install: both write nothing.
 * A failed check leaves the facts at their last successful knowledge; a failed
 * install leaves the prior facts untouched and surfaces only transiently.
 */
export type BinaryEntryFacts = {
  latestKnownVersion: string | null
  lastCheckedAtUtc: string | null
}

/**
 * Record the latest version an operation resolved, as of `nowIso`. The ONE
 * transition both writers share: a currency check learns the latest, and an
 * install learns it too (it just downloaded it). Neither records what is now
 * installed — that is read back from the artifact.
 */
export function recordLatest<T extends BinaryEntryFacts>(
  entry: T,
  version: string,
  nowIso: string,
): T {
  return { ...entry, latestKnownVersion: version, lastCheckedAtUtc: nowIso }
}

const ROLE_RANK: Record<Role, number> = { none: 0, info: 1, warning: 2, error: 3 }

/**
 * The single indicator for a whole set takes the worst role present
 * (error > warning > info > none) — invariant I6.
 */
export function rollupRole(roles: Role[]): Role {
  return roles.reduce<Role>((worst, r) => (ROLE_RANK[r] > ROLE_RANK[worst] ? r : worst), 'none')
}
