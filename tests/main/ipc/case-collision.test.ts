import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { caseInsensitiveSiblingExists } from '@main/ipc/library'

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

describe('caseInsensitiveSiblingExists', () => {
  it('flags a sibling that differs only in case (import: "Take.wav" present, target "take.wav")', async () => {
    await seed('Take.wav')
    // A case-sensitive existence check would miss this on Linux and let the import
    // copy "take.wav" in, clobbering "Take.wav" the moment the pair reaches macOS.
    expect(await caseInsensitiveSiblingExists(join(dir, 'take.wav'))).toBe(true)
  })

  it('detects the exact same name too, so the original refuse-on-existing behavior is kept', async () => {
    await seed('take.wav')
    expect(await caseInsensitiveSiblingExists(join(dir, 'take.wav'))).toBe(true)
  })

  it('treats composed and decomposed Unicode spellings as one portable sibling', async () => {
    await seed('Cafe\u0301.wav')
    expect(await caseInsensitiveSiblingExists(join(dir, 'Caf\u00e9.wav'))).toBe(true)
  })

  it('does not flag a genuinely unique name', async () => {
    await seed('Take.wav')
    expect(await caseInsensitiveSiblingExists(join(dir, 'other.wav'))).toBe(false)
  })

  it('permits a re-case of the tape\'s own file but still catches a DIFFERENT sibling (rename: "Take.wav" -> "take.wav")', async () => {
    await seed('Take.wav') // the tape's own media, being renamed to "take.wav"
    await seed('take.mp4') // an unrelated sibling that must not block the rename
    // Own name excluded -> the only case-insensitive match for "take.wav" is itself, so no collision.
    expect(await caseInsensitiveSiblingExists(join(dir, 'take.wav'), ['Take.wav'])).toBe(false)
    // But a sibling that case-clashes with a DIFFERENT target name is still caught.
    await seed('Clip.wav')
    expect(await caseInsensitiveSiblingExists(join(dir, 'clip.wav'), ['Take.wav'])).toBe(true)
  })

  it('treats a missing directory as no collision', async () => {
    expect(await caseInsensitiveSiblingExists(join(dir, 'nope', 'take.wav'))).toBe(false)
  })
})
