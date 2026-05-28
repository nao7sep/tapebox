import { readFile } from 'node:fs/promises'
import writeFileAtomic from 'write-file-atomic'
import type { ZodType } from 'zod'

/**
 * Atomic JSON read/write with optional zod validation.
 * Write semantics: write to temp -> fsync -> rename -> fsync parent dir.
 * Crash-safe: a partially-written temp file never replaces the target.
 */

export async function readJsonOptional<T>(
  path: string,
  schema: ZodType<T>,
): Promise<T | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return schema.parse(JSON.parse(text))
}

export async function readJson<T>(path: string, schema: ZodType<T>): Promise<T> {
  const value = await readJsonOptional(path, schema)
  if (value === null) throw new Error(`Required JSON file missing: ${path}`)
  return value
}

export async function writeJsonAtomic<T>(
  path: string,
  data: T,
  schema?: ZodType<T>,
): Promise<void> {
  const validated = schema ? schema.parse(data) : data
  const text = JSON.stringify(validated, null, 2) + '\n'
  await writeFileAtomic(path, text, { encoding: 'utf8', fsync: true })
}
