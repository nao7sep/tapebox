import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSidecarFile, writeSidecar } from '@main/core/sidecar'

// A tape's sidecar carries its format version (store-recovery-conventions). One
// without marker 1 is unreadable, what TapeBox writes carries 1, and one in a
// newer format is refused by name and left byte-identical.

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-sidecar-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sidecar format version', () => {
  it('refuses a sidecar without marker 1 as unreadable', async () => {
    const path = join(dir, 'Take.json')
    for (const formatVersion of [undefined, 0, 'one']) {
      await writeFile(path, JSON.stringify({ formatVersion, id: 'source', tapebox: { name: 'Take' } }))
      await expect(readSidecarFile(path), String(formatVersion)).rejects.toThrow(/this build reads format 1/)
    }
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
    expect(await readFile(path, 'utf8')).toBe(text)
    expect(await readdir(dir)).toEqual(['Take.json'])
  })
})
