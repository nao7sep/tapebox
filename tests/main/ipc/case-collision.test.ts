import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { portableSiblingExists } from '@main/io/portable-directory'

// The collision guard behind library:rename / library:import / export:files. macOS
// and Windows are case-insensitive, so "Take.wav" and "take.wav" are one file there
// and one silently clobbers the other; storage-path-conventions makes a
// case-insensitive sibling a hard collision. Exercised against a real temp dir
// (like library-move.test.ts) so the readdir-based fold is checked end to end on a
// case-sensitive CI filesystem, where a plain stat("take.wav") would report missing.

let dir: string

async function seed(name: string): Promise<void> {
  await writeFile(join(dir, name), 'x')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-case-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('portableSiblingExists', () => {
  it('flags a sibling that differs only in case (import: "Take.wav" present, target "take.wav")', async () => {
    await seed('Take.wav')
    // A case-sensitive existence check would miss this on Linux and let the import
    // copy "take.wav" in, clobbering "Take.wav" the moment the pair reaches macOS.
    expect(await portableSiblingExists(join(dir, 'take.wav'))).toBe(true)
  })

  it('detects the exact same name too, so the original refuse-on-existing behavior is kept', async () => {
    await seed('take.wav')
    expect(await portableSiblingExists(join(dir, 'take.wav'))).toBe(true)
  })

  it('treats composed and decomposed Unicode spellings as one portable sibling', async () => {
    await seed('Cafe\u0301.wav')
    expect(await portableSiblingExists(join(dir, 'Caf\u00e9.wav'))).toBe(true)
  })

  it('does not flag a genuinely unique name', async () => {
    await seed('Take.wav')
    expect(await portableSiblingExists(join(dir, 'other.wav'))).toBe(false)
  })

  it('treats a missing directory as no collision', async () => {
    expect(await portableSiblingExists(join(dir, 'nope', 'take.wav'))).toBe(false)
  })
})
