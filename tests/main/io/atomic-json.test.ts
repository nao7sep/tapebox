import { access, chmod, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import * as fileIo from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { serializeStoreJson, writeJsonAtomic } from '@main/io/atomic-json'
import { FORMATS } from '@main/io/file-header'
import { header } from '../../helpers/file-header'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open) }
})
vi.mock('@main/store/backupStore', () => ({ record: vi.fn() }))

// Real filesystem (a temp dir) so the write-temp -> fsync -> rename discipline
// (delegated to writeFileAtomicVia — see atomic-file.test.ts for that layer's own
// coverage) is actually exercised for JSON specifically: the serialized shape,
// the temp naming, and the mode option the secrets file relies on.

const V1 = { format: FORMATS.layout }
const HEADER = header('layout')
const HEADER_TEXT = '  "format": {\n    "owner": "tapebox",\n    "kind": "layout",\n    "version": 1\n  },\n  "writer": {\n    "name": "tapebox",\n    "version": "1.0.0"\n  },\n'

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

  it('writes pretty-printed JSON with a trailing newline', async () => {
    const target = join(dir, 'config.json')

    await writeJsonAtomic(target, { a: 1, b: 'two' }, V1)

    expect(await readFile(target, 'utf8')).toBe(`{\n${HEADER_TEXT}  "a": 1,\n  "b": "two"\n}\n`)
  })

  it('validates and canonicalizes through the schema before writing', async () => {
    const target = join(dir, 'config.json')
    const schema = z.object({ count: z.number().default(0) })

    await writeJsonAtomic(target, {}, { ...V1, schema })

    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ ...HEADER, count: 0 })
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

    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ ...HEADER, version: 2 })
    expect(await readdir(dir)).toEqual(['config.json'])
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
  it('leads with the header, replacing any format or writer the value held', () => {
    expect(serializeStoreJson({ a: 1, format: 7, writer: 'someone' }, V1))
      .toBe(`{\n${HEADER_TEXT}  "a": 1\n}\n`)
  })

  it('adds the header after the schema, which would strip it', () => {
    const schema = z.object({ a: z.number() })
    expect(JSON.parse(serializeStoreJson({ a: 1 }, { ...V1, schema }))).toEqual({ ...HEADER, a: 1 })
  })
})

