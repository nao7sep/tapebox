import { open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomicVia } from './atomic-file'
import { NewerFormatError, parseStoreJson, withFormatVersion } from './format-version'
import { record } from '@main/store/backupStore'
import { utcTimestampForFilenameMs } from '@shared/utc'
import { log } from './logger'
import { describeError } from '@shared/error'

/**
 * Atomic JSON store writes with zod validation.
 *
 * The write delegates to {@link writeFileAtomicVia}: write-temp -> fsync ->
 * rename -> fsync parent dir, with the temp a same-directory `<stem>-<nanoid>.tmp`
 * sibling (the atomic-write-temp-files convention).
 * Crash-safe: a partially-written temp file never replaces the target.
 *
 * There are two atomic-write entry points here, and the split is the ONE thing to
 * get right for the data-backup layer:
 *
 *   - {@link writeManagedJson} is the single managed-TEXT choke point. It is the
 *     ONLY place a data-backup record fires, strictly AFTER the rename lands, and
 *     it is what config.json / catalog.json save through. A managed-text write
 *     that bypasses it is a silent backup gap (data-backup conventions).
 *   - {@link writeJsonAtomic} is the raw atomic-write primitive for JSON that must
 *     NOT be recorded — the binary-bearing library sidecars, the exported bundle's
 *     sidecar, the secret api-keys.json, re-derivable dependencies.json facts, and
 *     the volatile-state layout.json. It never touches the backup store.
 *
 * Generic shape: <S extends z.ZodType> captures the actual schema so that
 * z.infer<S> resolves to the OUTPUT type (defaults applied, transforms run),
 * not the input shape.
 */

/** How a store's JSON is written: its format version, and the shape it is
 *  validated against first when given. */
export type StoreJsonOptions<S extends z.ZodType> = {
  formatVersion: number
  schema?: S
  /** Only disposable state and re-derived caches may replace unreadable bytes. */
  discardUnreadable?: boolean
  /** Recheck the caller's live mutation basis at the final publication boundary. */
  validateCurrent?: () => Promise<void>
}

/** Admit the current governing file; absence permits creating a new store. */
export async function assertJsonFileCurrent(path: string, current: number, discardUnreadable = false): Promise<void> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const found = parseStoreJson(text, current)
  if (found.status === 'newer') throw new NewerFormatError(path, found.version, current)
  if (found.status === 'unreadable' && !discardUnreadable) {
    throw new Error(`${path} is unreadable and was left in place`, { cause: found.error })
  }
}

async function publishJson(path: string, bytes: string | Buffer, options: { mode?: number; admit: () => Promise<void> }): Promise<void> {
  let stageCreated = false
  await writeFileAtomicVia(path, async (tempPath) => {
    const file = await open(tempPath, 'wx', 0o600)
    stageCreated = true
    try {
      await file.writeFile(bytes)
    } catch (error) {
      await file.close().catch((closeError: unknown) => {
        log.warn('JSON stage did not close cleanly', { error: describeError(closeError) })
      })
      throw error
    }
    await file.close()
  }, undefined, undefined, options.mode, options.admit, async (tempPath) => {
    if (stageCreated) await unlink(tempPath)
  })
}

/** Serialize a store's value to the canonical on-disk JSON form (2-space indent,
 *  trailing newline), validating through `schema` first when given and leading
 *  with its `formatVersion` (store-recovery-conventions). The single serializer
 *  every JSON store write shares, so the bytes recorded are byte-identical to the
 *  bytes on disk. */
export function serializeStoreJson<S extends z.ZodType>(
  data: z.input<S> | z.infer<S>,
  { formatVersion, schema }: StoreJsonOptions<S>,
): string {
  const validated = (schema ? schema.parse(data) : data) as object
  return JSON.stringify(withFormatVersion(validated, formatVersion), null, 2) + '\n'
}

/**
 * Raw atomic JSON write, NOT recorded to the data-backup store. A file that
 * already holds the same bytes is left as it is. For JSON that is
 * excluded from the backup by design-time, per-write-site decision: the binary-
 * bearing library/export sidecars, the secret api-keys.json, re-derivable
 * dependency/update facts, and the volatile-state layout.json (see the module
 * docstring). Managed text goes through {@link writeManagedJson} instead.
 */
export async function writeJsonAtomic<S extends z.ZodType>(
  path: string,
  data: z.input<S> | z.infer<S>,
  options: StoreJsonOptions<S> & {
    // POSIX file mode for the written file (e.g. 0o600 for a secrets file). When
    // omitted, the file keeps the mode of the one it replaces, or the process's
    // ordinary runtime defaults when it is new.
    mode?: number
  },
): Promise<void> {
  const { mode } = options
  const text = serializeStoreJson(data, options)
  const admit = async () => {
    await assertJsonFileCurrent(path, options.formatVersion, options.discardUnreadable)
    await options.validateCurrent?.()
  }
  await admit()
  if (await holdsAlready(path, text, mode)) return
  await publishJson(path, text, { mode, admit })
}

/** Whether `path` already holds exactly `text` (and `mode`, when one is asked for),
 * so writing it again would change nothing but the file's modified time
 * (content-lifecycle conventions). */
async function holdsAlready(path: string, text: string, mode: number | undefined): Promise<boolean> {
  let current: Buffer
  try {
    current = await readFile(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  if (!current.equals(Buffer.from(text, 'utf8'))) return false
  return mode === undefined || ((await stat(path)).mode & 0o777) === mode
}

/**
 * The single managed-TEXT atomic-write choke point, shared by config.json
 * (store/config.ts) and catalog.json (store/session.ts) — the app's durable,
 * user-authored text. It writes atomically exactly like {@link writeJsonAtomic},
 * and then, **strictly AFTER the rename lands**, records the exact bytes just
 * written into the data-backup store.
 *
 * Recording after the rename (never before) is a hard rule of the data-backup
 * conventions: recording first would risk a "backup of a save that never happened"
 * — if the rename then failed and the save was abandoned, the history would hold a
 * version that never reached disk. So: rename lands, THEN record the same `text`
 * bytes already in hand (never a re-read, which could capture a concurrent writer's
 * content instead of what this call wrote).
 *
 * The record is best-effort and silent: {@link record} catches, logs once at
 * `warn`, and swallows every failure, so a backup problem can never throw back into
 * this write or break the save that already succeeded above (see backupStore.ts).
 */
export async function writeManagedJson<S extends z.ZodType>(
  path: string,
  data: z.input<S> | z.infer<S>,
  options: StoreJsonOptions<S>,
): Promise<void> {
  const text = serializeStoreJson(data, options)
  const bytes = Buffer.from(text, 'utf8')
  const admit = async () => {
    await assertJsonFileCurrent(path, options.formatVersion, options.discardUnreadable)
    await options.validateCurrent?.()
  }
  await admit()
  if (await holdsAlready(path, text, undefined)) return
  await publishJson(path, bytes, { admit })
  // After the rename: the file is exactly where it belongs, so record the bytes we
  // just wrote. Best-effort — record() never throws — so a backup problem can never
  // break the save that already succeeded above.
  record(path, bytes)
}

/**
 * Move a corrupt managed file aside to its timestamped `<stem>-<stamp>.invalid`
 * sibling, preserving its bytes, and return the quarantine path. The rename
 * either lands or its failure propagates — the caller decides whether that is
 * fatal (session), required before recovery (config), or degradable (api-keys).
 * The one home of the quarantine naming grammar, so the three stores cannot
 * drift apart on it.
 */
export async function quarantineFile(filePath: string): Promise<string> {
  const stem = basename(filePath, extname(filePath))
  const quarantinePath = join(dirname(filePath), `${stem}-${utcTimestampForFilenameMs()}.invalid`)
  await rename(filePath, quarantinePath)
  return quarantinePath
}
