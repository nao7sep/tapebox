import { access, chmod, constants, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { binaryPath, ensureDirs, paths } from '@main/paths'
import { log } from '@main/io/logger'
import { emit } from '@main/ipc/events'
import { getSettings, updateSettings } from '@main/store/config'
import { execCapture } from '@main/io/spawn'
import { nowUtcIso } from '@shared/utc'
import { withRetry } from '@main/io/retry'
import type { BinaryName, BinaryStatus } from '@shared/ipc-contract'
import { binaryNames, binarySpecs } from './registry'
import { downloadWithProgress } from './http'
import { extractFileFromZip } from './archive'

/**
 * Per-binary install / update orchestration.
 *
 * Layout on disk:
 *   ~/.tapebox/bin/{name}{ext}              -- the installed executable
 *   ~/.tapebox/work/downloads/{tmp}         -- in-progress downloads
 *
 * Install is atomic: download to temp, extract/move to final, then chmod.
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
  const current = getSettings().binaries
  const nextBinaries = { ...current }
  let resolved = 0
  let failed = 0

  await Promise.all(
    binaryNames.map(async (name) => {
      try {
        const asset = await binarySpecs[name].resolveLatest()
        nextBinaries[name] = {
          ...current[name],
          latestKnownVersion: asset.version,
          lastCheckedAtUtc: now,
        }
        resolved++
      } catch (err) {
        failed++
        log.warn(`binary update check failed: ${name}`, { error: String(err) })
      }
    }),
  )

  log.info('binary update check complete', { resolved, failed })
  if (resolved > 0) await updateSettings({ binaries: nextBinaries })
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
  log.info(`binary install start: ${name}`)
  emit('binaries:progress', { name, percent: 0, phase: 'download' })

  const spec = binarySpecs[name]
  const resolved = await spec.resolveLatest()
  log.info(`binary resolved: ${name} ${resolved.version}`, { url: resolved.downloadUrl })

  await ensureDirs()
  const tempPath = join(paths.workDownloads, `${name}-${Date.now()}.partial`)

  const downloadPolicy = getSettings().network.binaryDownload
  let lastEmittedPct = -1
  await withRetry(downloadPolicy, () =>
    downloadWithProgress({
      url: resolved.downloadUrl,
      destPath: tempPath,
      idleTimeoutMs: downloadPolicy.timeoutMs ?? undefined,
      onProgress: (received, total) => {
        const pct = total > 0 ? Math.floor((received / total) * 100) : 0
        if (pct !== lastEmittedPct) {
          lastEmittedPct = pct
          emit('binaries:progress', { name, percent: pct, phase: 'download' })
        }
      },
    }),
  )

  emit('binaries:progress', { name, percent: 0, phase: 'install' })

  const finalPath = binaryPath(name)
  try {
    if (resolved.archive) {
      await extractFileFromZip(tempPath, resolved.archive.innerName, finalPath)
    } else {
      await rename(tempPath, finalPath)
    }
  } finally {
    await unlink(tempPath).catch(() => {})
  }

  if (process.platform !== 'win32') {
    await chmod(finalPath, 0o755)
    // Strip macOS Gatekeeper quarantine if present; harmless when absent.
    if (process.platform === 'darwin') {
      await execCapture('xattr', ['-d', 'com.apple.quarantine', finalPath], { reject: false })
        .catch(() => {})
    }
  }

  emit('binaries:progress', { name, percent: 100, phase: 'verify' })
  // Confirm the binary executes, but record resolved.version rather than the
  // self-reported one: ffmpeg reports a builder suffix ("8.1.1-tessus") and
  // deno a "v" prefix, which would otherwise never equal the upstream version
  // the update check compares against, flagging a phantom update on install.
  const selfReported = await verifyVersion(name)
  log.info(`binary installed: ${name} ${resolved.version}`, { selfReported })

  const current = getSettings().binaries
  await updateSettings({
    binaries: {
      ...current,
      [name]: {
        ...current[name],
        installedVersion: resolved.version,
        latestKnownVersion: resolved.version,
        lastCheckedAtUtc: nowUtcIso(),
      },
    },
  })

  emit('binaries:ready', { name, version: resolved.version })
}
