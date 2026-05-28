import { readFile } from 'node:fs/promises'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'

/**
 * Atomic JSON read/write with zod validation.
 *
 * Write semantics: write to temp -> fsync -> rename -> fsync parent dir.
 * Crash-safe: a partially-written temp file never replaces the target.
 *
 * Generic shape: <S extends ZodTypeAny> captures the actual schema so that
 * z.infer<S> resolves to the OUTPUT type (defaults applied, transforms run),
 * not the input shape. Avoids the zod 3.25 ZodType<T> ambiguity where T
 * collapses to the input side.
 */

export async function readJsonOptional<S extends z.ZodTypeAny>(
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

export async function readJson<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
): Promise<z.infer<S>> {
  const value = await readJsonOptional(path, schema)
  if (value === null) throw new Error(`Required JSON file missing: ${path}`)
  return value
}

export async function writeJsonAtomic<S extends z.ZodTypeAny>(
  path: string,
  data: z.input<S> | z.infer<S>,
  schema?: S,
): Promise<void> {
  const validated = schema ? schema.parse(data) : data
  const text = JSON.stringify(validated, null, 2) + '\n'
  await writeFileAtomic(path, text, { encoding: 'utf8', fsync: true })
}
