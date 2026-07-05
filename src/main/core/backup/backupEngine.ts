/**
 * Runs one backup pass and returns a {@link BackupReport}. It never throws for an expected problem (a
 * fatal error is captured in the report) and never logs — the caller logs the report. See the data-backup
 * conventions: change is size + mtime, the archive mirrors `~/.tapebox/`, and the archive is written and
 * renamed into place *before* the index so a crash never records a phantom backup.
 */
import fs from 'node:fs'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { nanoid } from 'nanoid'
import yazl from 'yazl'
import { paths } from '@main/paths'
import { writeJsonAtomic } from '@main/io/atomic-json'
import { writeFileAtomicVia } from '@main/io/atomic-file'
import { utcTimestampForFilenameMs } from '@shared/utc'
import { collectRoots } from './backupCollector'
import { selectChanged } from './backupPlan'
import { toIsoSeconds } from './backupTime'
import type { BackupCandidate, BackupIndex, BackupReport, BackupSkip } from './backupTypes'

/** Captures everything changed since the last run. `now` is a parameter so the archive stamp is
 *  deterministic under test. */
export async function runBackup(now: Date): Promise<BackupReport> {
  try {
    return await runCore(now)
  } catch (fatal) {
    return { nothingChanged: false, filesArchived: 0, skips: [], indexWasReset: false, fatal }
  }
}

async function runCore(now: Date): Promise<BackupReport> {
  const { index, indexWasReset } = await loadIndex()
  const { candidates, skips } = await collectRoots()

  const changed = selectChanged(candidates, index)
  if (changed.length === 0) {
    return { nothingChanged: true, filesArchived: 0, skips, indexWasReset }
  }

  const { archived, archivedAt, archiveFileName } = await writeArchive(now, changed, skips)
  if (archived.length === 0 || archivedAt === null || archiveFileName === null) {
    // Every changed file vanished before it could be archived; nothing was written, nothing is recorded.
    return { nothingChanged: true, filesArchived: 0, skips, indexWasReset }
  }

  for (const item of archived) {
    index.entries.push({
      archivedAt,
      archivePath: item.archivePath,
      sizeBytes: item.sizeBytes,
      lastWriteUtc: toIsoSeconds(item.mtimeMs),
    })
  }
  // Index second: the archive is already in place, so a crash here just re-captures next run.
  await writeJsonAtomic(paths.backupIndex, index)

  return { nothingChanged: false, archiveFileName, filesArchived: archived.length, skips, indexWasReset }
}

async function loadIndex(): Promise<{ index: BackupIndex; indexWasReset: boolean }> {
  const indexPath = paths.backupIndex
  let raw: string
  try {
    raw = await fs.promises.readFile(indexPath, 'utf-8')
  } catch (err) {
    // Absent index (first run, or freshly relocated root) is normal: back up everything.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { index: { entries: [] }, indexWasReset: false }
    }
    // Unreadable for another reason — treat as reset (full backup) rather than fail the run.
    return { index: { entries: [] }, indexWasReset: true }
  }

  try {
    const parsed = JSON.parse(raw) as BackupIndex
    if (!parsed || !Array.isArray(parsed.entries)) throw new Error('malformed index')
    return { index: { entries: parsed.entries }, indexWasReset: false }
  } catch {
    // A corrupt index is deleted and treated as empty: the run becomes a full backup, costing one
    // redundant archive, never data.
    await tryDelete(indexPath)
    return { index: { entries: [] }, indexWasReset: true }
  }
}

/** Streams the changed files to a temp zip and renames it into place, returning the files that were
 *  actually archived (a file that vanished since collection is skipped, not recorded) along with the
 *  stamp that won. `archivedAt`/`archiveFileName` are `null` when nothing was archived (caller ignores
 *  them then). */
async function writeArchive(
  now: Date,
  changed: readonly BackupCandidate[],
  skips: BackupSkip[],
): Promise<{ archived: BackupCandidate[]; archivedAt: string | null; archiveFileName: string | null }> {
  const dir = await ensureBackupsDir()

  const zip = new yazl.ZipFile()
  const archived: BackupCandidate[] = []
  for (const item of changed) {
    if (!fs.existsSync(item.sourcePath)) {
      skips.push({ path: item.archivePath, reason: 'vanished before archive' })
      continue
    }
    zip.addFile(item.sourcePath, item.archivePath)
    archived.push(item)
  }
  if (archived.length === 0) {
    return { archived, archivedAt: null, archiveFileName: null }
  }

  // No-clobber create: if `backup-<archivedAt>.zip` is already taken (another instance stamped the same
  // millisecond), advance the stamp to the next free millisecond and use that name for both the zip and
  // the index records that follow — an existence-check-then-rename is the accepted, best-effort mechanism
  // per the data-backup conventions, not a locked/exclusive create.
  const { archivedAt, archiveFileName } = resolveArchiveStamp(dir, now)
  const finalPath = path.join(dir, archiveFileName)

  zip.end()
  // Write-temp → fsync → rename → fsync-dir, with the temp a sibling in the backups dir so the rename is
  // atomic (same filesystem). Named <stem>-<nanoid>.tmp per the atomic-write-temp-files convention: the
  // stem is the archive name with its .zip stripped.
  const stem = archiveFileName.slice(0, -path.extname(archiveFileName).length)
  await writeFileAtomicVia(
    finalPath,
    (tempPath) => pipeline(zip.outputStream, createWriteStream(tempPath)),
    path.join(dir, `${stem}-${nanoid(10)}.tmp`),
  )
  return { archived, archivedAt, archiveFileName }
}

/** Finds the first `backup-<archivedAt>.zip` name not already present in `dir`, advancing `now` by whole
 *  milliseconds until one is free. Kept as its own existence-check-then-rename step (not a locked/atomic
 *  create) per the data-backup conventions' no-clobber rule. */
function resolveArchiveStamp(dir: string, now: Date): { archivedAt: string; archiveFileName: string } {
  let candidate = now
  for (;;) {
    const archivedAt = utcTimestampForFilenameMs(candidate)
    const archiveFileName = `backup-${archivedAt}.zip`
    if (!fs.existsSync(path.join(dir, archiveFileName))) {
      return { archivedAt, archiveFileName }
    }
    candidate = new Date(candidate.getTime() + 1)
  }
}

async function ensureBackupsDir(): Promise<string> {
  const dir = paths.backups
  await fs.promises.mkdir(dir, { recursive: true })
  return dir
}

async function tryDelete(target: string): Promise<void> {
  try {
    await fs.promises.rm(target, { force: true })
  } catch {
    // best effort: a leftover temp is harmless and lives under the excluded backups/ directory
  }
}
