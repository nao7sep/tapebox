/**
 * The managed-dependency state model (managed-dependency-status-conventions).
 *
 * A managed binary's state is a NESTED lifecycle — is it here and usable? — with
 * a currency sub-state — is it the version we want? — that exists only while it
 * is Provisioned. Everything shown is computed by `deriveStatus`, one pure rule
 * over recorded facts: no filesystem probe, no `--version` call, no network. The
 * UI renders its output and nothing else (Separation-of-Concerns rule #4 — the
 * state decision is extracted from the view so it can be unit-tested, and that
 * test is what keeps the honest-state principle honest rather than aspirational).
 *
 * The honest-state principle, enforced by the invariants the tests pin: never
 * report a state the facts do not support. "Could not check" is Check-failed or
 * Unchecked, never Current. "Present" is not "usable" — a failed integrity check
 * is Faulted, not Provisioned. "Never asked" (Unchecked) and "asked and failed"
 * (Check-failed) are different facts a user acts on differently.
 *
 * Lives in @shared (no node imports) so the renderer — typechecked without
 * @types/node — derives state through the very same rule the main process records.
 */

/** The primary state: is the dependency here and usable? */
export type Lifecycle = 'absent' | 'provisioned' | 'faulted' | 'unmanaged'

/** A sub-state of Provisioned only: is it the version we want? */
export type Currency = 'unchecked' | 'current' | 'stale' | 'check-failed'

/** The three semantic roles a surface renders through; the theme owns the colour. */
export type Role = 'none' | 'info' | 'warning' | 'error'

/** The named operations a user can take on a managed dependency. */
export type Operation = 'provision' | 'check' | 'update' | 'verify' | 'repair'

/**
 * The recorded facts about one managed dependency the derivation reads. `present`
 * is cheaply re-probed by the fact-gathering step in main (not persisted, so it
 * can't drift from disk); everything else is persisted per-dependency and is the
 * single source of truth. `checkError` and `faultError` are kept apart so each
 * maps to exactly one state — a failed check is Check-failed, a failed integrity
 * is Faulted — rather than one ambiguous error field the surface has to guess at.
 */
export type DependencyFacts = {
  present: boolean
  integrity: 'verified' | 'failed' | null
  installedVersion: string | null
  desiredVersion: string | null
  lastCheckedAtUtc: string | null
  checkError: string | null
  faultError: string | null
}

export type DerivedStatus = {
  lifecycle: Lifecycle
  /** null unless lifecycle is 'provisioned' (invariant I2). */
  currency: Currency | null
  role: Role
  /** The primary operation the surface offers, or null when there's nothing to do. */
  operation: Operation | null
  /** The message for an error/warning surface (a fault or a failed check), or null. */
  detail: string | null
}

function deriveLifecycle(f: DependencyFacts): Lifecycle {
  if (!f.present) return 'absent'
  if (f.integrity === 'failed') return 'faulted'
  if (f.integrity === 'verified') return 'provisioned'
  // integrity unrecorded: a recorded installedVersion is proof THIS app provisioned
  // it (a config written before the integrity field existed, or pre-verify), so it
  // is Provisioned, not Unmanaged. Only a present file we have no record of — a
  // user-placed copy — is Unmanaged.
  return f.installedVersion !== null ? 'provisioned' : 'unmanaged'
}

function deriveCurrency(f: DependencyFacts): Currency {
  // A failed check is the most recent truth about freshness — any prior answer is
  // no longer trusted as fresh — so it wins over a stale/current version compare.
  if (f.checkError !== null) return 'check-failed'
  // No desired version has ever been resolved: we genuinely don't know.
  if (f.desiredVersion === null) return 'unchecked'
  if (f.desiredVersion !== f.installedVersion) return 'stale'
  return 'current'
}

function roleOf(lifecycle: Lifecycle, currency: Currency | null): Role {
  if (lifecycle === 'faulted') return 'error'
  if (lifecycle === 'absent') return 'warning'
  if (lifecycle === 'unmanaged') return 'info'
  // provisioned
  switch (currency) {
    case 'check-failed': return 'error'
    case 'stale':        return 'warning'
    case 'unchecked':    return 'info'
    case 'current':      return 'none'
    default:             return 'none'
  }
}

function operationOf(lifecycle: Lifecycle, currency: Currency | null): Operation | null {
  if (lifecycle === 'absent') return 'provision'
  if (lifecycle === 'unmanaged') return 'provision' // replace the user copy with a managed one
  if (lifecycle === 'faulted') return 'repair'
  // provisioned
  if (currency === 'stale') return 'update'
  if (currency === 'unchecked' || currency === 'check-failed') return 'check'
  return null // current: nothing required (Verify is offered separately, always)
}

/**
 * Compute the displayed state of one managed dependency from its recorded facts.
 * Pure and total — a function of the persisted facts alone. Transient operation
 * status (a running install's progress, a just-failed action) is layered over this
 * by the surface, never folded into the persisted state, so it stays a separate
 * concern the renderer owns.
 */
export function deriveStatus(facts: DependencyFacts): DerivedStatus {
  const lifecycle = deriveLifecycle(facts)
  const currency = lifecycle === 'provisioned' ? deriveCurrency(facts) : null
  const detail =
    lifecycle === 'faulted' ? facts.faultError
    : currency === 'check-failed' ? facts.checkError
    : null

  return {
    lifecycle,
    currency,
    role: roleOf(lifecycle, currency),
    operation: operationOf(lifecycle, currency),
    detail,
  }
}

/**
 * The persisted-fact transitions an operation applies to a binary's settings entry.
 * Pure (no I/O) so the honest-state rules — a failed check never rewrites the
 * version, a Verify hash-mismatch is the sole entry into Faulted — are unit-tested
 * directly, with the manager reduced to gathering the outcome and persisting it.
 *
 * Typed against the persisted subset rather than importing the full settings
 * schema, so this stays node-/zod-free for the renderer bundle. The manager spreads
 * the returned fields over the live BinaryEntry.
 */
export type BinaryEntryFacts = {
  installedVersion: string | null
  latestKnownVersion: string | null
  lastCheckedAtUtc: string | null
  integrity: 'verified' | 'failed' | null
  verifiedSha256: string | null
  checkError: string | null
  faultError: string | null
}

export type CheckOutcome = { ok: true; version: string } | { ok: false; error: string }

/** Apply a currency-check result. Success records the desired version and clears the
 *  error; failure records only the timestamp and error (I3: the version is never
 *  rewritten, so a failed check derives to Check-failed, never Current). */
export function applyCheckOutcome<T extends BinaryEntryFacts>(entry: T, outcome: CheckOutcome, nowIso: string): T {
  if (outcome.ok) {
    return { ...entry, latestKnownVersion: outcome.version, lastCheckedAtUtc: nowIso, checkError: null }
  }
  return { ...entry, lastCheckedAtUtc: nowIso, checkError: outcome.error }
}

export type InstallOutcome = {
  version: string
  integrityVerified: boolean
  sha256: string
  nowIso: string
}

/** Apply a successful Provision/Update. A download that passed integrity and
 *  installed is Provisioned, recording the verified hash so a later Verify can
 *  detect corruption. Acquiring resolves the latest, so it also establishes
 *  currency (installed === latest → Current), clearing any prior error. Runnability
 *  is deliberately not probed here — the status model scopes faults to integrity
 *  (the recorded hash), and Faulted is reached only by a later Verify mismatch. */
export function nextEntryAfterInstall<T extends BinaryEntryFacts>(entry: T, o: InstallOutcome): T {
  return {
    ...entry,
    installedVersion: o.version,
    latestKnownVersion: o.version,
    lastCheckedAtUtc: o.nowIso,
    integrity: o.integrityVerified ? 'verified' : null,
    verifiedSha256: o.integrityVerified ? o.sha256 : null,
    checkError: null,
    faultError: null,
  }
}

export type VerifyOutcome = { currentSha: string }

/** Apply an on-demand Verify — a pure integrity re-check of the installed file
 *  against the checksum recorded at install (never a re-download, never a runnability
 *  probe). A hash mismatch is the sole entry into Faulted; a match re-affirms
 *  Verified, baselining the hash if none was recorded (legacy/trust-on-first-verify). */
export function nextEntryAfterVerify<T extends BinaryEntryFacts>(entry: T, o: VerifyOutcome): T {
  if (entry.verifiedSha256 !== null && o.currentSha !== entry.verifiedSha256) {
    return { ...entry, integrity: 'failed', faultError: 'integrity check failed: the installed file changed since it was verified' }
  }
  return { ...entry, integrity: 'verified', verifiedSha256: entry.verifiedSha256 ?? o.currentSha, faultError: null }
}

const ROLE_RANK: Record<Role, number> = { none: 0, info: 1, warning: 2, error: 3 }

/**
 * The single indicator for a whole set takes the worst role present
 * (error > warning > informational > none) — invariant I7.
 */
export function rollupRole(roles: Role[]): Role {
  return roles.reduce<Role>((worst, r) => (ROLE_RANK[r] > ROLE_RANK[worst] ? r : worst), 'none')
}
