import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSidecar, readSidecarFile, writeSidecar } from '@main/core/sidecar'

// A tape's sidecar carries its format version (store-recovery-conventions). One
// without its marker is unreadable, what TapeBox writes carries 1, and one in a
// newer format is refused by name and left byte-identical.

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-sidecar-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sidecar format version', () => {
  it('reads a sidecar without its marker as one v0.1.0 wrote', async () => {
    const path = join(dir, 'Take.json')
    await writeFile(path, JSON.stringify({ id: 'source', tapebox: { name: 'Take' } }))
    await expect(readSidecarFile(path)).resolves.toEqual({ id: 'source', tapebox: { name: 'Take' } })
  })

  it('reads a sidecar whose marker is not a version as unreadable', async () => {
    const path = join(dir, 'Take.json')
    await writeFile(path, JSON.stringify({ formatVersion: 'one', id: 'source' }))
    await expect(readSidecarFile(path)).rejects.toThrow(/positive integer/)
    expect(await readSidecar(path)).toBeNull()
  })

  it('writes format 1 first and reads it back', async () => {
    const path = join(dir, 'Take.json')
    await writeSidecar(path, { id: 'source', tapebox: { name: 'Take' } })
    expect(Object.keys(JSON.parse(await readFile(path, 'utf8')))).toEqual(['formatVersion', 'id', 'tapebox'])
    expect(await readSidecarFile(path)).toEqual({ formatVersion: 1, id: 'source', tapebox: { name: 'Take' } })
  })

  it('refuses a newer sidecar by name and leaves it byte-identical', async () => {
    const path = join(dir, 'Take.json')
    const text = JSON.stringify({ formatVersion: 2, id: 'source', description: 'Future' })
    await writeFile(path, text)

    await expect(readSidecarFile(path)).rejects.toMatchObject({
      name: 'UserFacingError',
      userMessage: { key: 'errors.fileNewer', values: { name: 'Take.json' } },
    })
    expect(await readSidecar(path), 'the best-effort read treats it as absent').toBeNull()
    expect(await readFile(path, 'utf8')).toBe(text)
    expect(await readdir(dir)).toEqual(['Take.json'])
  })
})
