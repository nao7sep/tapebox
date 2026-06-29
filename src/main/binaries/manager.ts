import { access, chmod, constants, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { binaryPath, ensureDirs, paths } from '@main/paths'
import { log } from '@main/io/logger'
import { emit } from '@main/ipc/events'
import { getSettings, mutateSettings } from '@main/store/config'
import { execCapture } from '@main/io/spawn'
import { writeFileAtomicVia } from '@main/io/atomic-file'
import { describeError, errorMessage } from '@shared/error'
import { nowUtcIso } from '@shared/utc'
import {
  applyCheckOutcome,
  nextEntryAfterInstall,
  nextEntryAfterVerify,
  type CheckOutcome,
} from '@shared/binary-status'
import { withRetry } from '@main/io/retry'
import { BINARY_DOWNLOAD_IDLE_TIMEOUT_MS, HTTP_RETRY } from '@main/io/network'
import type { BinaryName, BinaryStatus } from '@shared/ipc-contract'
import { binaryNames, binarySpecs } from './registry'
import { downloadWithProgress } from './http'
import { extractFileFromZip } from './archive'
import { sha256OfFile, verifyBinaryIntegrity } from './integrity'

/**
 * Per-binary install / update orchestration.
 *
 * Layout on disk:
 *   ~/.tapebox/bin/{name}{ext}              -- the installed executable
 *   ~/.tapebox/work/downloads/{tmp}         -- in-progress downloads
 *
 * Install is atomic and crash-durable: download to a work temp, then prepare the
 * executable at a staging file (extract or move, then chmod) and publish it with
 * one fsync'd rename (writeFileAtomicVia) — so the file at bin/ only ever appears
 * complete, executable, and flushed, never mid-extract or pre-chmod.
 * Concurrent installOrUpdate for the same name is serialized by a Set lock.
 *
 * Update-check policy: settings.binaries.<name>.{latestKnownVersion,
 * lastCheckedAtUtc} are the single source of truth — there's no in-memory
 * cache. The modal renders what's persisted; a fresh upstream lookup happens
 * only on startup (gated by checkToolUpdates) or via an explicit user
 * action. This keeps GitHub API hits well under the unauthenticated rate
 * limit.
 */

const inFlight = new Set<BinaryName>()

/**
 * Serialize operations per binary (the convention's per-dependency rule): a second
 * action on the same binary is rejected rather than racing the first. One lock
 * covers install/update, repair, and verify alike.
 */
async function withBinaryLock<T>(name: BinaryName, run: () => Promise<T>): Promise<T> {
  if (inFlight.has(name)) {
    throw new Error(`${name} operation already in progress`)
  }
  inFlight.add(name)
  try {
    return await run()
  } finally {
    inFlight.delete(name)
  }
}

async function isInstalled(name: BinaryName): Promise<boolean> {
  try {
    await access(binaryPath(name), constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Assemble the recorded facts for one binary: the persisted entry plus a freshly
// re-probed `present` (cheap filesystem check, not persisted, so it can't drift
// from disk). The renderer derives lifecycle/currency/role from these via the
// shared deriveStatus — main records facts, it does not pre-derive state.
async function getStatus(name: BinaryName): Promise<BinaryStatus> {
  const entry = getSettings().binaries[name]
  const present = await isInstalled(name)
  return {
    name,
    present,
    integrity: entry.integrity,
    installedVersion: entry.installedVersion,
    latestKnownVersion: entry.latestKnownVersion,
    lastCheckedAtUtc: entry.lastCheckedAtUtc,
    checkError: entry.checkError,
    faultError: entry.faultError,
  }
}

export async function getAllStatuses(): Promise<BinaryStatus[]> {
  return Promise.all(binaryNames.map(getStatus))
}

/**
 * Resolve the latest upstream version of every binary and record the outcome of
 * each check honestly. Every binary's lastCheckedAtUtc advances on the attempt; a
 * success records latestKnownVersion and clears any prior error, while a failure
 * (network down, a version string we couldn't parse, ffmpeg on Linux) records the
 * error — deriving to Check-failed — and leaves the version untouched. A failed
 * check is never silently dropped to "unchecked" or left showing a stale Current.
 */
export async function checkForUpdates(): Promise<BinaryStatus[]> {
  const now = nowUtcIso()
  const outcomes = new Map<BinaryName, CheckOutcome>()

  await Promise.all(
    binaryNames.map(async (name) => {
      try {
        const asset = await binarySpecs[name].resolveLatest()
        outcomes.set(name, { ok: true, version: asset.version })
      } catch (err) {
        outcomes.set(name, { ok: false, error: errorMessage(err) })
        log.warn('binary update check failed', { name, error: describeError(err) })
      }
    }),
  )

  const failed = [...outcomes.values()].filter((o) => !o.ok).length
  log.info('binary update check complete', { resolved: outcomes.size - failed, failed })
  // Apply inside the settings critical section: read the *current* entry (so a
  // concurrent install's fields are preserved) and fold in each check outcome.
  await mutateSettings((s) => {
    const nextBinaries = { ...s.binaries }
    for (const [name, outcome] of outcomes) {
      nextBinaries[name] = applyCheckOutcome(s.binaries[name], outcome, now)
    }
    return { binaries: nextBinaries }
  })
  return getAllStatuses()
}

export async function installOrUpdate(name: BinaryName): Promise<void> {
  await withBinaryLock(name, () => performInstall(name))
}

/**
 * Re-confirm a provisioned binary on demand: a pure integrity re-check that re-hashes
 * the installed file against the checksum recorded at install. A hash mismatch moves
 * it to Faulted; a match re-affirms Provisioned. Runnability is not probed — integrity
 * is the recorded checksum. A binary we never provisioned (Absent, or a user-placed
 * Unmanaged copy) has nothing for us to verify and is left untouched. Serialized
 * against install via the same per-binary lock. Returns the refreshed statuses.
 */
export async function verify(name: BinaryName): Promise<BinaryStatus[]> {
  return withBinaryLock(name, async () => {
    await performVerify(name)
    return getAllStatuses()
  })
}

async function performVerify(name: BinaryName): Promise<void> {
  const entry = getSettings().binaries[name]
  // Only re-verify something this app provisioned (a recorded installedVersion).
  if (entry.installedVersion === null || !(await isInstalled(name))) return

  // A pure integrity re-check: re-hash the on-disk file against the checksum
  // recorded at install. A mismatch is the sole entry into Faulted; runnability is
  // not probed (the status model scopes faults to integrity, not execution).
  const currentSha = await sha256OfFile(binaryPath(name))
  log.info('binary verify', { name })

  await mutateSettings((s) => ({
    binaries: {
      ...s.binaries,
      [name]: nextEntryAfterVerify(s.binaries[name], { currentSha }),
    },
  }))
}

async function performInstall(name: BinaryName): Promise<void> {
  log.info('binary install start', { name })
  emit('binaries:progress', { name, percent: 0, phase: 'download' })

  const spec = binarySpecs[name]
  const resolved = await spec.resolveLatest()
  log.info('binary resolved', { name, version: resolved.version, url: resolved.downloadUrl })

  await ensureDirs()
  const downloadTemp = join(paths.workDownloads, `${name}-${Date.now()}.partial`)

  let lastEmittedPct = -1
  await withRetry(HTTP_RETRY, () =>
    downloadWithProgress({
      url: resolved.downloadUrl,
      destPath: downloadTemp,
      idleTimeoutMs: BINARY_DOWNLOAD_IDLE_TIMEOUT_MS,
      onProgress: (received, total) => {
        const pct = total > 0 ? Math.floor((received / total) * 100) : 0
        if (pct !== lastEmittedPct) {
          lastEmittedPct = pct
          emit('binaries:progress', { name, percent: pct, phase: 'download' })
        }
      },
    }),
  )

  const finalPath = binaryPath(name)
  let integrityVerified = false
  try {
    // Integrity gate: verify the downloaded bytes against the vendor's published
    // SHA-256 sums file before making them executable. A failure throws and aborts
    // the install (the temp is cleaned in the finally below); a source that
    // publishes nothing is logged and installed unverified (https-only transport
    // still applies), and its integrity is recorded as unestablished, not verified.
    const integrity = await verifyBinaryIntegrity(downloadTemp, resolved.integrity)
    integrityVerified = integrity.verified
    if (integrity.verified) {
      log.info('binary integrity verified', { name, method: integrity.method })
    } else {
      log.warn('binary integrity unavailable; installed unverified', { name })
    }

    emit('binaries:progress', { name, percent: 0, phase: 'install' })

    // Prepare the complete, executable binary at a staging file, then publish it
    // with one atomic fsync'd rename. The chmod/de-quarantine happen on the stage
    // BEFORE it becomes finalPath, so a concurrent status check or a crash can
    // never catch the binary present-but-not-yet-runnable.
    await writeFileAtomicVia(finalPath, async (stage) => {
      if (resolved.archive) {
        await extractFileFromZip(downloadTemp, resolved.archive.innerName, stage)
      } else {
        await rename(downloadTemp, stage)
      }
      if (process.platform !== 'win32') {
        await chmod(stage, 0o755)
        // Strip macOS Gatekeeper quarantine if present; harmless when absent.
        if (process.platform === 'darwin') {
          await execCapture('xattr', ['-d', 'com.apple.quarantine', stage], { reject: false })
            .catch(() => {})
        }
      }
    })
  } finally {
    await unlink(downloadTemp).catch(() => {})
  }

  emit('binaries:progress', { name, percent: 100, phase: 'verify' })
  // Hash the published binary so a later Verify can re-check it against this value.
  // We record resolved.version (the upstream string), not a self-reported one;
  // runnability is not probed — integrity is the recorded checksum, and a later
  // Verify mismatch is the only thing that faults a tool.
  const installedSha = await sha256OfFile(finalPath)
  log.info('binary installed', { name, version: resolved.version, integrityVerified })

  await mutateSettings((s) => ({
    binaries: {
      ...s.binaries,
      [name]: nextEntryAfterInstall(s.binaries[name], {
        version: resolved.version,
        integrityVerified,
        sha256: installedSha,
        nowIso: nowUtcIso(),
      }),
    },
  }))

  emit('binaries:ready', { name, version: resolved.version })
}
