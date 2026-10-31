import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSidecarFile, writeSidecar } from '@main/core/sidecar'
import { header, sidecarFixture } from '../../helpers/file-header'

// A tape's sidecar carries its header (file-identity-conventions). One without
// it is unreadable, what TapeBox writes carries it, and one in a
// newer format is refused by name and left byte-identical.

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-sidecar-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sidecar header', () => {
  it('refuses a sidecar without its header, or another owner\'s or kind\'s, as unreadable', async () => {
    const path = join(dir, 'Take.json')
    for (const format of [undefined, { owner: 'tapebox', kind: 'sidecar', version: 0 }, { owner: 'gptimg', kind: 'sidecar', version: 1 }, { owner: 'tapebox', kind: 'tape', version: 1 }]) {
      await writeFile(path, JSON.stringify({ format, ytDlp: { id: 'source' }, tapebox: { name: 'Take' } }))
      await expect(readSidecarFile(path), JSON.stringify(format)).rejects.toThrow(/not a TapeBox sidecar/)
    }
    await writeFile(path, JSON.stringify({ formatVersion: 1, id: 'source', tapebox: { name: 'Take' } }))
    await expect(readSidecarFile(path), 'the old marker').rejects.toThrow(/no format header/)
  })

  it('refuses a sidecar without its ytDlp or tapebox section', async () => {
    const path = join(dir, 'Take.json')
    for (const body of [{ tapebox: {} }, { ytDlp: {} }, { ytDlp: [], tapebox: {} }]) {
      await writeFile(path, JSON.stringify({ ...header('sidecar'), ...body }))
      await expect(readSidecarFile(path), JSON.stringify(body)).rejects.toThrow(/ytDlp and a tapebox section/)
    }
  })

  it('writes the header first and reads the content back without it, never reading the writer', async () => {
    const path = join(dir, 'Take.json')
    await writeSidecar(path, { ytDlp: { id: 'source', format: 'yt-dlp format 22' }, tapebox: { name: 'Take' } })
    const written = JSON.parse(await readFile(path, 'utf8'))
    expect(Object.keys(written)).toEqual(['format', 'writer', 'ytDlp', 'tapebox'])
    expect(written).toMatchObject({ format: { owner: 'tapebox', kind: 'sidecar', version: 1 }, writer: { name: 'tapebox', version: '1.0.0' } })
    expect(await readSidecarFile(path)).toEqual({ ytDlp: { id: 'source', format: 'yt-dlp format 22' }, tapebox: { name: 'Take' } })
    await writeFile(path, JSON.stringify({ ...written, writer: 'not an object' }))
    expect(await readSidecarFile(path)).toEqual({ ytDlp: { id: 'source', format: 'yt-dlp format 22' }, tapebox: { name: 'Take' } })
  })

  it('refuses a newer sidecar by name and leaves it byte-identical', async () => {
    const path = join(dir, 'Take.json')
    const text = JSON.stringify(sidecarFixture({ id: 'source', description: 'Future' }, undefined, 2))
    await writeFile(path, text)

    await expect(readSidecarFile(path)).rejects.toMatchObject({
      name: 'UserFacingError',
      userMessage: { key: 'errors.fileNewer', values: { name: 'Take.json' } },
    })
    expect(await readFile(path, 'utf8')).toBe(text)
    expect(await readdir(dir)).toEqual(['Take.json'])
  })
})
