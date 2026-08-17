import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomicVia } from './atomic-file'
import { record } from '@main/store/backupStore'
import { utcTimestampForFilenameMs } from '@shared/utc'

/**
 * Atomic JSON read/write with zod validation.
 *
 * The write delegates to {@link writeFileAtomicVia}: write-temp -> fsync ->
 * rename -> fsync parent dir, with the temp a same-directory
 * `<stem>-<nanoid>.tmp` sibling (the atomic-write-temp-files convention).
 * Crash-safe: a partially-written temp file never replaces the target.
 *
 * There are two atomic-write entry points here, and the split is the ONE thing to
 * get right for the data-backup layer:
 *
 *   - {@link writeManagedJson} is the single managed-TEXT choke point. It is the
 *     ONLY place a data-backup record fires, strictly AFTER the rename lands, and
 *     it is what config.json / catalog.json / layout.json save through. A managed-
 *     text write that bypasses it is a silent backup gap (data-backup conventions).
 *   - {@link writeJsonAtomic} is the raw atomic-write primitive for JSON that must
 *     NOT be recorded — the binary-bearing library sidecars, the exported bundle's
 *     sidecar, and the secret api-keys.json. It never touches the backup store.
 *
 * Generic shape: <S extends z.ZodType> captures the actual schema so that
 * z.infer<S> resolves to the OUTPUT type (defaults applied, transforms run),
 * not the input shape.
 */

export async function readJsonOptional<S extends z.ZodType>(
  path: string,
  schema: S,
): Promise<z.infer<S> | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return schema.parse(JSON.parse(text)) as z.infer<S>
}

/** Serialize a value to the canonical on-disk JSON form (2-space indent, trailing
 *  newline), validating through `schema` first when given. The single serializer
 *  both write paths share, so the bytes recorded are byte-identical to the bytes on
 *  disk. */
function serializeJson<S extends z.ZodType>(data: z.input<S> | z.infer<S>, schema?: S): string {
  const validated = schema ? schema.parse(data) : data
  return JSON.stringify(validated, null, 2) + '\n'
}

/**
 * Raw atomic JSON write, NOT recorded to the data-backup store. For JSON that is
 * excluded from the backup by design-time, per-write-site decision: the binary-
 * bearing library/export sidecars and the secret api-keys.json (see the module
 * docstring). Managed text goes through {@link writeManagedJson} instead.
 */
export async function writeJsonAtomic<S extends z.ZodType>(
  path: string,
  data: z.input<S> | z.infer<S>,
  schema?: S,
  // POSIX file mode for the written file (e.g. 0o600 for a secrets file). When
  // omitted, the file is created with the process's default mode.
  mode?: number,
): Promise<void> {
  const text = serializeJson(data, schema)
  await writeFileAtomicVia(path, async (tempPath) => {
    await writeFile(tempPath, text, 'utf8')
    // chmod (not the open mode) is what guarantees the exact bits regardless of
    // the process umask — the same belt-and-suspenders write-file-atomic used.
    if (mode !== undefined) await chmod(tempPath, mode)
  })
}

/**
 * The single managed-TEXT atomic-write choke point, shared by config.json
 * (store/config.ts), catalog.json (store/session.ts), and layout.json
 * (store/layout.ts) — the app's durable, user-authored text. It writes atomically
 * exactly like {@link writeJsonAtomic}, and then, **strictly AFTER the rename
 * lands**, records the exact bytes just written into the data-backup store.
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
  schema?: S,
): Promise<void> {
  const text = serializeJson(data, schema)
  const bytes = Buffer.from(text, 'utf8')
  await writeFileAtomicVia(path, async (tempPath) => {
    await writeFile(tempPath, bytes)
  })
  // After the rename: the file is exactly where it belongs, so record the bytes we
  // just wrote. Best-effort — record() never throws — so a backup problem can never
  // break the save that already succeeded above.
  record(path, bytes)
}

/**
 * Move a corrupt managed file aside to its timestamped `<stem>-<stamp>.invalid`
 * sibling, preserving its bytes, and return the quarantine path. The rename
 * either lands or its failure propagates — the caller decides whether that is
 * fatal (session), a reseed precondition (config), or degradable (api-keys).
 * The one home of the quarantine naming grammar, so the three stores cannot
 * drift apart on it.
 */
export async function quarantineFile(filePath: string): Promise<string> {
  const stem = basename(filePath, extname(filePath))
  const quarantinePath = join(dirname(filePath), `${stem}-${utcTimestampForFilenameMs()}.invalid`)
  await rename(filePath, quarantinePath)
  return quarantinePath
}
