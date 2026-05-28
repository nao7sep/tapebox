import { access, chmod, constants, mkdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { binaryPath, paths } from '@main/paths'
import { log } from '@main/io/logger'
import { emit } from '@main/ipc/events'
import { getSettings, updateSettings } from '@main/store/config'
import { execCapture } from '@main/io/spawn'
import { nowUtcIso } from '@shared/utc'
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
 */

const installing = new Set<BinaryName>()
const latestKnown = new Map<BinaryName, string>()

async function isInstalled(name: BinaryName): Promise<boolean> {
  try {
    await access(binaryPath(name), constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function verifyVersion(name: BinaryName): Promise<string> {
  const spec = binarySpecs[name]
  const { stdout } = await execCapture(binaryPath(name), [spec.versionFlag], { reject: false })
  return spec.parseVersion(stdout)
}

export async function getStatus(name: BinaryName): Promise<BinaryStatus> {
  const settings = getSettings()
  const entry = settings.binaries[name]
  const installed = await isInstalled(name)
  return {
    name,
    installedVersion: installed ? entry.installedVersion : null,
    latestKnownVersion: latestKnown.get(name) ?? null,
    lastCheckedAtUtc: entry.lastCheckedAtUtc,
    isUpdating: installing.has(name),
  }
}

export async function getAllStatuses(): Promise<BinaryStatus[]> {
  return Promise.all(binaryNames.map(getStatus))
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
  latestKnown.set(name, resolved.version)
  log.info(`binary resolved: ${name} ${resolved.version}`, { url: resolved.downloadUrl })

  await mkdir(paths.workDownloads, { recursive: true })
  const tempPath = join(paths.workDownloads, `${name}-${Date.now()}.partial`)

  let lastEmittedPct = -1
  await downloadWithProgress({
    url: resolved.downloadUrl,
    destPath: tempPath,
    onProgress: (received, total) => {
      const pct = total > 0 ? Math.floor((received / total) * 100) : 0
      if (pct !== lastEmittedPct) {
        lastEmittedPct = pct
        emit('binaries:progress', { name, percent: pct, phase: 'download' })
      }
    },
  })

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
  const version = await verifyVersion(name)
  log.info(`binary installed: ${name} ${version}`)

  const current = getSettings().binaries
  await updateSettings({
    binaries: {
      ...current,
      [name]: {
        ...current[name],
        installedVersion: version,
        lastCheckedAtUtc: nowUtcIso(),
      },
    },
  })

  emit('binaries:ready', { name, version })
}

export async function checkForUpdates(name?: BinaryName): Promise<BinaryStatus[]> {
  const targets = name ? [name] : binaryNames.slice()
  for (const n of targets) {
    try {
      const resolved = await binarySpecs[n].resolveLatest()
      latestKnown.set(n, resolved.version)
      const current = getSettings().binaries
      await updateSettings({
        binaries: {
          ...current,
          [n]: { ...current[n], lastCheckedAtUtc: nowUtcIso() },
        },
      })
      const installed = current[n].installedVersion
      if (installed && installed !== resolved.version) {
        emit('binaries:updateAvailable', {
          name: n,
          currentVersion: installed,
          latestVersion: resolved.version,
        })
      }
    } catch (err) {
      log.warn(`update check failed: ${n}`, { error: String(err) })
    }
  }
  return getAllStatuses()
}
