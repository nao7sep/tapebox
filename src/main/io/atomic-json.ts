import { chmod, readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { writeFileAtomicVia } from './atomic-file'

/**
 * Atomic JSON read/write with zod validation.
 *
 * The write delegates to {@link writeFileAtomicVia}: write-temp -> fsync ->
 * rename -> fsync parent dir, with the temp a same-directory
 * `<stem>-<nanoid>.tmp` sibling (the atomic-write-temp-files convention).
 * Crash-safe: a partially-written temp file never replaces the target.
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

export async function writeJsonAtomic<S extends z.ZodType>(
  path: string,
  data: z.input<S> | z.infer<S>,
  schema?: S,
  // POSIX file mode for the written file (e.g. 0o600 for a secrets file). When
  // omitted, the file is created with the process's default mode.
  mode?: number,
): Promise<void> {
  const validated = schema ? schema.parse(data) : data
  const text = JSON.stringify(validated, null, 2) + '\n'
  await writeFileAtomicVia(path, async (tempPath) => {
    await writeFile(tempPath, text, 'utf8')
    // chmod (not the open mode) is what guarantees the exact bits regardless of
    // the process umask — the same belt-and-suspenders write-file-atomic used.
    if (mode !== undefined) await chmod(tempPath, mode)
  })
}
