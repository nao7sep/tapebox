import { access, chmod, constants, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { binaryPath, ensureDirs, paths } from '@main/paths'
import { log } from '@main/io/logger'
import { emit } from '@main/ipc/events'
import { getSettings, mutateSettings } from '@main/store/config'
import { execCapture } from '@main/io/spawn'
import { writeFileAtomicVia } from '@main/io/atomic-file'
import { describeError } from '@shared/error'
import { nowUtcIso } from '@shared/utc'
import { withRetry } from '@main/io/retry'
import { BINARY_DOWNLOAD_IDLE_TIMEOUT_MS, HTTP_RETRY } from '@main/io/network'
import type { BinaryName, BinaryStatus } from '@shared/ipc-contract'
import { binaryNames, binarySpecs } from './registry'
import { downloadWithProgress } from './http'
import { extractFileFromZip } from './archive'
import { resolveExpectedSha256, sha256OfFile } from './checksum'

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
 * only on startup (gated by autoCheckBinaryUpdates) or via an explicit user
 * action. This keeps GitHub API hits well under the unauthenticated rate
 * limit.
 */

const installing = new Set<BinaryName>()

async function isInstalled(name: BinaryName): Promise<boolean> {
  try {
    await access(binaryPath(name), constants.X_OK)
    return true
  } catch {
    return false
  }
}

// A `--version` call is local and quick, but a wedged binary shouldn't hang the
// check forever — an idle watchdog turns that into a prompt failure instead.
const VERSION_CHECK_IDLE_TIMEOUT_MS = 15_000

async function verifyVersion(name: BinaryName): Promise<string> {
  const spec = binarySpecs[name]
  const { stdout } = await execCapture(binaryPath(name), [spec.versionFlag], {
    reject: false,
    idleTimeoutMs: VERSION_CHECK_IDLE_TIMEOUT_MS,
  })
  return spec.parseVersion(stdout)
}

async function getStatus(name: BinaryName): Promise<BinaryStatus> {
  const settings = getSettings()
  const entry = settings.binaries[name]
  const installed = await isInstalled(name)
  return {
    name,
    installedVersion: installed ? entry.installedVersion : null,
    latestKnownVersion: entry.latestKnownVersion,
    lastCheckedAtUtc: entry.lastCheckedAtUtc,
    isUpdating: installing.has(name),
  }
}

export async function getAllStatuses(): Promise<BinaryStatus[]> {
  return Promise.all(binaryNames.map(getStatus))
}

/**
 * Resolve the latest upstream version of every binary and persist them.
 *
 * Resilient: a binary whose resolveLatest throws (e.g. ffmpeg on Linux) is
 * logged and skipped — the others still update. lastCheckedAtUtc and
 * latestKnownVersion are persisted only for binaries that resolved successfully.
 */
export async function checkForUpdates(): Promise<BinaryStatus[]> {
  const now = nowUtcIso()
  const resolvedVersions = new Map<BinaryName, string>()
  let failed = 0

  await Promise.all(
    binaryNames.map(async (name) => {
      try {
        const asset = await binarySpecs[name].resolveLatest()
        resolvedVersions.set(name, asset.version)
      } catch (err) {
        failed++
        log.warn('binary update check failed', { name, error: describeError(err) })
      }
    }),
  )

  log.info('binary update check complete', { resolved: resolvedVersions.size, failed })
  if (resolvedVersions.size > 0) {
    // Apply inside the settings critical section: read the *current* binaries (so a
    // concurrent install's installedVersion is preserved) and override only the
    // resolved fields.
    await mutateSettings((s) => {
      const nextBinaries = { ...s.binaries }
      for (const [name, version] of resolvedVersions) {
        nextBinaries[name] = { ...s.binaries[name], latestKnownVersion: version, lastCheckedAtUtc: now }
      }
      return { binaries: nextBinaries }
    })
  }
  return getAllStatuses()
}

export async function installOrUpdate(name: BinaryName): Promise<void> {
  if (installing.has(name)) {
    throw new Error(`${name} install already in progress`)
  }
  installing.add(name)
  try {
    await performInstall(name)
  } finally {
    installing.delete(name)
  }
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
  try {
    // Integrity gate: verify the downloaded bytes against the vendor's published
    // SHA-256 before making them executable. A mismatch aborts the install (the temp
    // is cleaned in the finally below); a vendor that publishes no checksum is logged
    // and installed unverified (https-only transport still applies).
    const expectedSha256 = await resolveExpectedSha256(resolved)
    if (expectedSha256) {
      const actual = await sha256OfFile(downloadTemp)
      if (actual !== expectedSha256) {
        throw new Error(`${name} download failed its checksum (expected ${expectedSha256}, got ${actual})`)
      }
      log.info('binary checksum verified', { name, sha256: expectedSha256 })
    } else {
      log.warn('binary checksum unavailable; installed unverified', { name })
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
  // Confirm the binary executes, but record resolved.version rather than the
  // self-reported one: ffmpeg reports a builder suffix ("8.1.1-tessus") that would
  // otherwise never equal the upstream version the update check compares against,
  // flagging a phantom update on install.
  const selfReported = await verifyVersion(name)
  log.info('binary installed', { name, version: resolved.version, selfReported })

  await mutateSettings((s) => ({
    binaries: {
      ...s.binaries,
      [name]: {
        ...s.binaries[name],
        installedVersion: resolved.version,
        latestKnownVersion: resolved.version,
        lastCheckedAtUtc: nowUtcIso(),
      },
    },
  }))

  emit('binaries:ready', { name, version: resolved.version })
}
