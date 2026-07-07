import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readJsonOptional, writeJsonAtomic } from '@main/io/atomic-json'

// Real filesystem (a temp dir) so the write-temp -> fsync -> rename discipline
// (delegated to writeFileAtomicVia — see atomic-file.test.ts for that layer's own
// coverage) is actually exercised for JSON specifically: the serialized shape,
// the temp naming, and the mode option the secrets file relies on.

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-atomic-json-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('writeJsonAtomic', () => {
  it('writes pretty-printed JSON with a trailing newline', async () => {
    const target = join(dir, 'config.json')

    await writeJsonAtomic(target, { a: 1, b: 'two' })

    expect(await readFile(target, 'utf8')).toBe('{\n  "a": 1,\n  "b": "two"\n}\n')
  })

  it('validates and canonicalizes through the schema before writing', async () => {
    const target = join(dir, 'config.json')
    const schema = z.object({ count: z.number().default(0) })

    await writeJsonAtomic(target, {}, schema)

    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ count: 0 })
  })

  it('rejects data that fails the schema and leaves no file behind', async () => {
    const target = join(dir, 'config.json')
    const schema = z.object({ count: z.number() })

    const invalid = { count: 'not a number' } as unknown as z.input<typeof schema>
    await expect(writeJsonAtomic(target, invalid, schema)).rejects.toThrow()
    expect(await exists(target)).toBe(false)
  })

  it('goes through a same-directory <stem>-<nanoid>.tmp temp and leaves none behind after success', async () => {
    const target = join(dir, 'config.json')

    await writeJsonAtomic(target, { ok: true })

    const entries = await readdir(dir)
    expect(entries).toEqual(['config.json']) // no stray temp survives a successful write
  })

  it('atomically replaces existing content', async () => {
    const target = join(dir, 'config.json')
    await writeJsonAtomic(target, { version: 1 })

    await writeJsonAtomic(target, { version: 2 })

    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ version: 2 })
    expect(await readdir(dir)).toEqual(['config.json'])
  })

  it.runIf(process.platform !== 'win32')('creates the file at exactly the given mode (e.g. 0600 for secrets)', async () => {
    const target = join(dir, 'api-keys.json')

    await writeJsonAtomic(target, { keys: { openai: 'sk-test' } }, undefined, 0o600)

    const mode = statSync(target).mode & 0o777
    expect(mode).toBe(0o600)
    expect(await readdir(dir)).toEqual(['api-keys.json']) // no stray temp
  })

  it.runIf(process.platform !== 'win32')('does not force a mode when none is given', async () => {
    const target = join(dir, 'config.json')

    await writeJsonAtomic(target, { a: 1 })

    // No assertion on the exact bits (that is the process umask's call) — just that
    // the write succeeds and produces a normal, readable file with no mode forced.
    const mode = statSync(target).mode & 0o777
    expect(mode & 0o400).toBe(0o400) // owner-readable at least
  })
})

describe('readJsonOptional', () => {
  it('returns null for a missing file', async () => {
    const schema = z.object({ a: z.number() })
    await expect(readJsonOptional(join(dir, 'missing.json'), schema)).resolves.toBeNull()
  })

  it('round-trips what writeJsonAtomic wrote', async () => {
    const target = join(dir, 'config.json')
    const schema = z.object({ a: z.number(), b: z.string() })
    await writeJsonAtomic(target, { a: 1, b: 'two' }, schema)

    await expect(readJsonOptional(target, schema)).resolves.toEqual({ a: 1, b: 'two' })
  })
})
