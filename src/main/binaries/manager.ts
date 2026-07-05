import { access, chmod, constants, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { binaryPath, ensureDirs, paths } from '@main/paths'
import { log } from '@main/io/logger'
import { emit } from '@main/ipc/events'
import { getSettings, mutateSettings } from '@main/store/config'
import { execCapture } from '@main/io/spawn'
import { writeFileAtomicVia } from '@main/io/atomic-file'
import { describeError } from '@shared/error'
import { nowUtcIso } from '@shared/utc'
import { applyCheckSuccess, nextEntryAfterInstall } from '@shared/binary-status'
import { withRetry } from '@main/io/retry'
import { BINARY_DOWNLOAD_IDLE_TIMEOUT_MS, HTTP_RETRY } from '@main/io/network'
import type { BinaryName, BinaryStatus } from '@shared/ipc-contract'
import { binaryNames, binarySpecs } from './registry'
import { downloadWithProgress } from './http'
import { extractFileFromZip } from './archive'
import { verifyBinaryIntegrity } from './integrity'
import { assertArm64Slice } from './arch'

/**
 * Per-binary install / update orchestration.
 *
 * Layout on disk:
 *   ~/.tapebox/bin/{name}{ext}              -- the installed executable
 *   ~/.tapebox/temp/{name}-{nanoid}.partial  -- disposable download staging (cleared on launch)
 *
 * Install is atomic and crash-durable: download to a temp file, then prepare the
 * executable at a staging file (extract or move, then chmod) and publish it with
 * one fsync'd rename (writeFileAtomicVia) — so the file at bin/ only ever appears
 * complete, executable, and flushed, never mid-extract or pre-chmod.
 * Concurrent installOrUpdate for the same name is serialized by a Set lock.
 *
 * Update-check policy: settings.binaries.<name>.{latestKnownVersion,
 * lastCheckedAtUtc} are the single source of truth — there's no in-memory
 * cache. The modal renders what's persisted; a fresh upstream lookup happens
 * only on startup (gated by checkUpdatesAtLaunch) or via an explicit user
 * action. This keeps GitHub API hits well under the unauthenticated rate
 * limit.
 */

const inFlight = new Set<BinaryName>()

/**
 * Serialize operations per binary (the convention's per-dependency rule): a second
 * install/update on the same binary is rejected rather than racing the first.
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

/**
 * The `<name>-<nanoid>.partial` download-staging filename inside paths.temp —
 * `<stem>-<discriminator>.<role-extension>` per the derived-sibling-name
 * convention. nanoid(10) is the discriminator, matching the app's other
 * derived-name sites (atomic-file.ts, rename-plan.ts): never a raw Date.now()
 * epoch, which two installs started in the same millisecond could collide on.
 * Pulled out of performInstall so the shape is assertable without driving a
 * full install.
 */
export function downloadTempPath(name: BinaryName): string {
  return join(paths.temp, `${name}-${nanoid(10)}.partial`)
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
    installedVersion: entry.installedVersion,
    latestKnownVersion: entry.latestKnownVersion,
    lastCheckedAtUtc: entry.lastCheckedAtUtc,
  }
}

export async function getAllStatuses(): Promise<BinaryStatus[]> {
  return Promise.all(binaryNames.map(getStatus))
}

/**
 * Resolve the latest upstream version of every binary. A success records that
 * binary's latestKnownVersion + lastCheckedAtUtc; a failure (network down, an
 * unparseable version, ffmpeg on Linux) writes **nothing** for that binary — no
 * version, no timestamp — so the displayed state stays at its last successful
 * knowledge (the convention's honest-state rule). Failures are logged, never
 * persisted, so there is no "check-failed" state to represent.
 */
export async function checkForUpdates(): Promise<BinaryStatus[]> {
  const now = nowUtcIso()
  const resolved = new Map<BinaryName, string>()
  let failed = 0

  await Promise.all(
    binaryNames.map(async (name) => {
      try {
        const asset = await binarySpecs[name].resolveLatest()
        resolved.set(name, asset.version)
      } catch (err) {
        // A failed check writes NOTHING (managed-runtime-dependencies-conventions):
        // no version, no timestamp, no error state — the displayed wording stays at
        // the last successful knowledge. Log it and move on.
        failed += 1
        log.warn('binary update check failed', { name, error: describeError(err) })
      }
    }),
  )

  log.info('binary update check complete', { resolved: resolved.size, failed })
  // Apply inside the settings critical section: read the *current* entry (so a
  // concurrent install's fields are preserved) and fold in each successful check.
  await mutateSettings((s) => {
    const nextBinaries = { ...s.binaries }
    for (const [name, version] of resolved) {
      nextBinaries[name] = applyCheckSuccess(s.binaries[name], version, now)
    }
    return { binaries: nextBinaries }
  })
  return getAllStatuses()
}

export async function installOrUpdate(name: BinaryName): Promise<void> {
  await withBinaryLock(name, () => performInstall(name))
}

async function performInstall(name: BinaryName): Promise<void> {
  log.info('binary install start', { name })
  emit('binaries:progress', { name, percent: 0, phase: 'download' })

  const spec = binarySpecs[name]
  const resolved = await spec.resolveLatest()
  log.info('binary resolved', { name, version: resolved.version, url: resolved.downloadUrl })

  await ensureDirs()
  const downloadTemp = downloadTempPath(name)

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
    emit('binaries:progress', { name, percent: 0, phase: 'verify' })
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
      // Architecture gate (macOS): reject an x86_64-only build before it is
      // published, so a wrong-arch download fails clean here rather than at exec
      // time on Apple Silicon (no Rosetta). A universal binary passes.
      if (process.platform === 'darwin') {
        await assertArm64Slice(stage)
      }
    })
  } finally {
    await unlink(downloadTemp).catch(() => {})
  }

  log.info('binary installed', { name, version: resolved.version, integrityVerified })

  await mutateSettings((s) => ({
    binaries: {
      ...s.binaries,
      [name]: nextEntryAfterInstall(s.binaries[name], {
        version: resolved.version,
        nowIso: nowUtcIso(),
      }),
    },
  }))

  emit('binaries:ready', { name, version: resolved.version })
}
