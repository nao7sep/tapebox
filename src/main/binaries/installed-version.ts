import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { binaryPath, paths } from '@main/paths'
import { execCapture } from '@main/io/spawn'
import { writeJsonAtomic } from '@main/io/atomic-json'
import { FORMAT_VERSIONS, parseStoreJson } from '@main/io/format-version'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import type { BinaryName } from '@shared/ipc-contract'
import { binarySpecs } from './registry'
import { sha256OfFile } from './integrity'

/**
 * The installed version of a managed binary, read FROM THE ARTIFACT
 * (managed-runtime-dependencies-conventions).
 *
 * The version used to live in dependencies.json, one file away from the binary it
 * described, with nothing keeping the two in step — so any install that didn't
 * write the record (one predating the tracking, an interrupted install, a
 * hand-placed file, the facts file deleted to clear something else) stranded a
 * present binary as permanently unversioned, which the status derivation can only
 * read as "installed (not checked)": never up to date, never update-available, and
 * so never offering the update that exists. Reading the version from the same place
 * presence is read makes that state unreachable rather than merely unlikely.
 *
 * Two sources, declared per binary by the registry: PROBE the binary (yt-dlp, deno,
 * macOS ffmpeg all report themselves in a namespace comparable with their
 * upstream's "latest"), or read the SIDECAR written beside it at install (Windows
 * ffmpeg, whose rolling master build cannot be compared with the release tag BtbN
 * publishes).
 *
 * A probe is a subprocess spawn, so it is cached per process and must never sit on
 * a render path: the renderer derives state from facts main gathered, and main
 * gathers them in the async status handler, not per frame. The cache is dropped
 * after an install, so the next read sees the new binary. A binary placed by hand
 * mid-session is picked up the moment it is present, because nothing is cached
 * while it is absent (callers skip the read then); only a FAILED read is remembered
 * for the process, and the surface offers the re-acquire that clears it.
 *
 * A failure — the binary won't run, exits non-zero, or prints something
 * unrecognized — yields null and is logged. That is NOT the same as absent, and it
 * can never read as up to date: a null installed version has nothing to compare, so
 * the derivation holds at "installed (not checked)".
 */

// A cold first launch of yt-dlp's standalone macOS binary can spend more than ten
// seconds in OS validation before it prints its version. Keep the probe bounded,
// but leave enough room for that supported artifact to start on a fast local disk.
const PROBE_IDLE_TIMEOUT_MS = 30_000
// Hashing a large binary under antivirus scanning can be slow; a read that runs
// out of time is retried at the next read rather than kept for the session.
const SIDECAR_HASH_TIMEOUT_MS = 30_000

/**
 * `bin/<name>.json` — the version sidecar beside `bin/<name>[.exe]`. Stem plus the
 * role extension, never a suffix dot-appended to the full filename (so it is
 * `ffmpeg.json`, not `ffmpeg.exe.json`), per the derived-filename grammar.
 */
export function versionSidecarPath(name: BinaryName): string {
  return join(paths.bin, `${name}.json`)
}

type VersionSidecar = { version: string; binarySha256: string }

function hashBinary(name: BinaryName, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(SIDECAR_HASH_TIMEOUT_MS)
  return sha256OfFile(binaryPath(name), signal ? AbortSignal.any([signal, timeout]) : timeout)
}

/**
 * Record the version of a just-published binary beside it. Called only for a
 * sidecar-tracked binary, and only AFTER the binary itself has landed: a crash
 * between the two leaves a present binary with a stale or absent sidecar, which
 * reads as version-unknown and offers a re-acquire — honest and self-correcting.
 * Writing the sidecar first would instead leave the OLD binary labelled with the
 * NEW version on a failed publish, which reads as up to date while it is not.
 */
export async function writeVersionSidecar(name: BinaryName, version: string, signal?: AbortSignal): Promise<void> {
  const binarySha256 = await hashBinary(name, signal)
  signal?.throwIfAborted()
  const sidecar: VersionSidecar = { version, binarySha256 }
  // not recorded: derived facts about a re-fetchable binary, rebuilt by the next
  // install (data-backup conventions protect only what the user creates or adds).
  // Any earlier sidecar is replaced, one from a newer TapeBox too: reinstalling is
  // how its facts are rebuilt, so refusing it would make every install fail.
  await writeJsonAtomic(versionSidecarPath(name), sidecar, { formatVersion: FORMAT_VERSIONS.binaryVersion })
}

const cache = new Map<BinaryName, Promise<string | null>>()

/** Drop a cached read so the next one re-reads the artifact. Called after an
 *  install publishes a new binary. */
export function forgetInstalledVersion(name: BinaryName): void {
  cache.delete(name)
}

/** Drop every cached read (tests, and any wholesale reset of the bin directory). */
export function forgetAllInstalledVersions(): void {
  cache.clear()
}

/**
 * The installed version of `name`, or null when it cannot be read. Callers check
 * presence first — an absent binary has no version to read, and skipping the call
 * is also what keeps a null from being cached for a binary that may appear later.
 */
export function readInstalledVersion(name: BinaryName): Promise<string | null> {
  const cached = cache.get(name)
  if (cached) return cached
  // resolveInstalledVersion never rejects, so a rejected promise can never be
  // cached and re-thrown at every later reader. A read that ran out of time is
  // dropped once settled, so the next reader tries again.
  const pending: Promise<string | null> = resolveInstalledVersion(name).then((read) => {
    if (read.retry && cache.get(name) === pending) cache.delete(name)
    return read.version
  })
  cache.set(name, pending)
  return pending
}

async function resolveInstalledVersion(name: BinaryName): Promise<{ version: string | null; retry: boolean }> {
  const source = binarySpecs[name].installedVersion
  return source.kind === 'probe'
    ? { version: await probe(name, source.args, source.parse), retry: false }
    : readSidecar(name, source.parse)
}

async function probe(
  name: BinaryName,
  args: readonly string[],
  parse: (stdout: string) => string | null,
): Promise<string | null> {
  const command = binaryPath(name)
  try {
    const { stdout, exitCode } = await execCapture(command, args, {
      reject: false,
      idleTimeoutMs: PROBE_IDLE_TIMEOUT_MS,
    })
    if (exitCode !== 0) {
      log.warn('installed version probe failed', { name, exitCode })
      return null
    }
    const version = parse(stdout)
    if (version === null) {
      log.warn('installed version probe printed nothing recognizable', {
        name,
        output: stdout.slice(0, 200),
      })
    }
    return version
  } catch (err) {
    // The binary is present (the caller scanned for it) but would not run: a wrong
    // architecture, a truncated file, a lost exec bit, or a wedged process the idle
    // watchdog killed. Present-but-unreadable, not absent.
    log.warn('installed version probe could not run', { name, error: describeError(err) })
    return null
  }
}

async function readSidecar(name: BinaryName, parse: (stored: string) => string | null): Promise<{ version: string | null; retry: boolean }> {
  const path = versionSidecarPath(name)
  try {
    return { version: await readSidecarVersion(name, path, parse), retry: false }
  } catch (err) {
    // Only the hash's time bound reaches here: every other failure reads as unknown.
    log.warn('version sidecar check ran out of time; it is tried again at the next read', { name, path, error: describeError(err) })
    return { version: null, retry: true }
  }
}

async function readSidecarVersion(name: BinaryName, path: string, parse: (stored: string) => string | null): Promise<string | null> {
  try {
    const found = parseStoreJson(await readFile(path, 'utf8'), FORMAT_VERSIONS.binaryVersion)
    if (found.status === 'newer') {
      log.warn('version sidecar is from a newer TapeBox', { name, path, formatVersion: found.version })
      return null
    }
    if (found.status === 'unreadable') throw found.error
    const sidecar = found.value as Partial<VersionSidecar>
    if (typeof sidecar.binarySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sidecar.binarySha256) ||
        sidecar.binarySha256 !== await hashBinary(name)) {
      log.warn('version sidecar does not describe the installed binary', { name, path })
      return null
    }
    const stored = sidecar.version
    if (typeof stored !== 'string' || stored.trim().length === 0) {
      log.warn('version sidecar holds no version', { name, path })
      return null
    }
    const version = parse(stored)
    if (version === null) log.warn('version sidecar holds an unrecognized version', { name, path, stored })
    return version
  } catch (err) {
    // A read has no other signal than the hash's time bound, so an abort is it.
    if (['TimeoutError', 'AbortError'].includes((err as Error | null)?.name ?? '')) throw err
    // Absent (a binary placed by hand, or installed before this sidecar existed) or
    // unreadable — either way the version is unknown, never assumed current.
    log.warn('version sidecar unreadable', { name, path, error: describeError(err) })
    return null
  }
}
