import { access, chmod, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import * as fileIo from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { serializeStoreJson, writeJsonAtomic } from '@main/io/atomic-json'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open) }
})

// Real filesystem (a temp dir) so the write-temp -> fsync -> rename discipline
// (delegated to writeFileAtomicVia — see atomic-file.test.ts for that layer's own
// coverage) is actually exercised for JSON specifically: the serialized shape,
// the temp naming, and the mode option the secrets file relies on.

const V1 = { formatVersion: 1 }

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-atomic-json-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
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
  it('refuses a current newer file and preserves its bytes and mode', async () => {
    const target = join(dir, 'config.json')
    const future = '{"formatVersion":2,"authored":"kept"}'
    await writeFile(target, future, { mode: 0o640 })
    const before = statSync(target)
    await expect(writeJsonAtomic(target, { authored: 'replacement' }, V1)).rejects.toThrow('format 2')
    expect(await readFile(target, 'utf8')).toBe(future)
    expect(statSync(target).mode).toBe(before.mode)
    expect(await readdir(dir)).toEqual(['config.json'])
  })

  it('rechecks the public target after private staging and cleans its stage on refusal', async () => {
    const target = join(dir, 'api-keys.json')
    await writeJsonAtomic(target, { keys: {} }, V1)
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const future = '{"formatVersion":2,"keys":{"openai":"kept"}}'
    const opened = vi.spyOn(fileIo, 'open').mockImplementation(async (...args) => {
      const file = await original.open(...args)
      try {
        if (String(args[0]).endsWith('.tmp') && args[1] === 'wx') {
          const stage = statSync(String(args[0]))
          expect(stage.size).toBe(0)
          if (process.platform !== 'win32') expect(stage.mode & 0o777).toBe(0o600)
          await original.writeFile(target, future)
        }
      } catch (error) { await file.close(); throw error }
      return file
    })
    await expect(writeJsonAtomic(target, { keys: { openai: 'replacement' } }, { ...V1, mode: 0o600 }))
      .rejects.toThrow('format 2')
    opened.mockRestore()
    expect(await readFile(target, 'utf8')).toBe(future)
    expect(await readdir(dir)).toEqual(['api-keys.json'])
  })

  it('does not remove a colliding stage whose exclusive creation failed', async () => {
    const target = join(dir, 'config.json')
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let collision: string | undefined
    const opened = vi.spyOn(fileIo, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.tmp') && args[1] === 'wx') {
        collision = String(args[0])
        await original.writeFile(collision, 'existing stage')
      }
      return original.open(...args)
    })
    await expect(writeJsonAtomic(target, { count: 1 }, V1)).rejects.toMatchObject({ code: 'EEXIST' })
    opened.mockRestore()
    expect(collision).toBeDefined()
    expect(await readFile(collision!, 'utf8')).toBe('existing stage')
    expect(await exists(target)).toBe(false)
  })

  it('only permits unreadable replacement for explicitly disposable data', async () => {
    const target = join(dir, 'layout.json')
    await writeFile(target, 'invalid')
    await expect(writeJsonAtomic(target, { width: 300 }, V1)).rejects.toThrow('left in place')
    expect(await readFile(target, 'utf8')).toBe('invalid')
    await writeJsonAtomic(target, { width: 300 }, { ...V1, discardUnreadable: true })
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ formatVersion: 1, width: 300 })
  })
  it('writes pretty-printed JSON with a trailing newline', async () => {
    const target = join(dir, 'config.json')

    await writeJsonAtomic(target, { a: 1, b: 'two' }, V1)

    expect(await readFile(target, 'utf8')).toBe('{\n  "formatVersion": 1,\n  "a": 1,\n  "b": "two"\n}\n')
  })

  it('validates and canonicalizes through the schema before writing', async () => {
    const target = join(dir, 'config.json')
    const schema = z.object({ count: z.number().default(0) })

    await writeJsonAtomic(target, {}, { ...V1, schema })

    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ formatVersion: 1, count: 0 })
  })

  it('rejects data that fails the schema and leaves no file behind', async () => {
    const target = join(dir, 'config.json')
    const schema = z.object({ count: z.number() })

    const invalid = { count: 'not a number' } as unknown as z.input<typeof schema>
    await expect(writeJsonAtomic(target, invalid, { ...V1, schema })).rejects.toThrow()
    expect(await exists(target)).toBe(false)
  })

  it('goes through a same-directory <stem>-<nanoid>.tmp temp and leaves none behind after success', async () => {
    const target = join(dir, 'config.json')

    await writeJsonAtomic(target, { ok: true }, V1)

    const entries = await readdir(dir)
    expect(entries).toEqual(['config.json']) // no stray temp survives a successful write
  })

  it('atomically replaces existing content', async () => {
    const target = join(dir, 'config.json')
    await writeJsonAtomic(target, { version: 1 }, V1)

    await writeJsonAtomic(target, { version: 2 }, V1)

    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ formatVersion: 1, version: 2 })
    expect(await readdir(dir)).toEqual(['config.json'])
  })

  it('leaves a file that already holds the same JSON untouched', async () => {
    const target = join(dir, 'layout.json')
    await writeJsonAtomic(target, { volume: 0.5 }, V1)
    const past = new Date('2020-01-01T00:00:00.000Z')
    await utimes(target, past, past)
    const before = statSync(target)

    await writeJsonAtomic(target, { volume: 0.5 }, V1)

    const after = statSync(target)
    expect(after.mtimeMs).toBe(past.getTime())
    expect(after.ino).toBe(before.ino)
  })

  it.runIf(process.platform !== 'win32')('rewrites same JSON whose file lacks the mode asked for', async () => {
    const target = join(dir, 'api-keys.json')
    await writeJsonAtomic(target, { keys: {} }, V1)
    await chmod(target, 0o644)

    await writeJsonAtomic(target, { keys: {} }, { ...V1, mode: 0o600 })

    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it.runIf(process.platform !== 'win32')('creates the file at exactly the given mode (e.g. 0600 for secrets)', async () => {
    const target = join(dir, 'api-keys.json')

    await writeJsonAtomic(target, { keys: { openai: 'sk-test' } }, { ...V1, mode: 0o600 })

    const mode = statSync(target).mode & 0o777
    expect(mode).toBe(0o600)
    expect(await readdir(dir)).toEqual(['api-keys.json']) // no stray temp
  })

  it.runIf(process.platform !== 'win32')('does not force a mode when none is given', async () => {
    const target = join(dir, 'config.json')

    await writeJsonAtomic(target, { a: 1 }, V1)

    const mode = statSync(target).mode & 0o777
    expect(mode).toBe(0o666 & ~process.umask())
  })
})

describe('serializeStoreJson', () => {
  it('leads with the format version, replacing any marker the value held', () => {
    expect(serializeStoreJson({ a: 1, formatVersion: 7 }, { formatVersion: 1 }))
      .toBe('{\n  "formatVersion": 1,\n  "a": 1\n}\n')
  })

  it('stamps the marker after the schema, which would strip it', () => {
    const schema = z.object({ a: z.number() })
    expect(JSON.parse(serializeStoreJson({ a: 1 }, { formatVersion: 1, schema }))).toEqual({ formatVersion: 1, a: 1 })
  })
})
