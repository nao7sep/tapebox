import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCollection } from '@main/store/session'
import { header } from '../../helpers/file-header'

// Real filesystem (a temp dir) so the read → parse → quarantine path is exercised
// end to end. readCollection is the path-taking seam the app singleton wraps.

let dir: string

function tapeFacts(id: string, sourceUrl: string, filename: string): Record<string, unknown> {
  return {
    id, sourceUrl, state: 'downloaded', addedAtUtc: '2026-01-01T00:00:00.000Z', addedIndex: 0,
    sourceId: id, extractor: 'test', title: 'Tape', uploader: null, durationSeconds: 1,
    chapterCount: 0, probedAtUtc: '2026-01-01T00:00:00.000Z', filename,
    sidecarFilename: `${id}.json`, thumbnailFilename: null, downloadStartedAtUtc: null,
    downloadedAtUtc: '2026-01-01T00:00:00.000Z', name: null, renamedAtUtc: null,
    pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
  }
}

/** Put a tape folder with its tape.json in the Inbox or the Shelf. */
async function writeTape(area: 'inbox' | 'shelf', tape: Record<string, unknown>, text = JSON.stringify({ ...header('tape'), ...tape })): Promise<string> {
  const folder = join(dir, area, tape.id as string)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'tape.json'), text)
  return join(folder, 'tape.json')
}

async function read(): Promise<Awaited<ReturnType<typeof readCollection>>> {
  return readCollection(dir)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-session-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readCollection', () => {
  it('returns an empty session when the collection has no files yet', async () => {
    const { result, session, damaged, shelfWritten } = await read()

    expect(result.status).toBe('empty')
    expect(session).toEqual({ tapes: [], boxes: [] })
    expect(damaged).toEqual([])
    expect(shelfWritten, 'the next save writes shelf.json').toBe(false)
  })

  it('loads a valid shelf file', async () => {
    await writeFile(join(dir, 'shelf.json'), JSON.stringify({ ...header('shelf'), boxes: [], loose: [] }))

    const { result, shelfWritten } = await read()

    expect(result.status).toBe('loaded')
    expect(shelfWritten).toBe(true)
  })

  it.each([
    ['unparseable', '{ this is not valid json'],
    ['schema-invalid', JSON.stringify({ ...header('shelf'), boxes: [{ id: 'x' }], loose: [] })],
  ])('refuses an %s shelf file, leaving it and every tape as they are', async (_label, bytes) => {
    const path = join(dir, 'shelf.json')
    await writeFile(path, bytes)
    const tapePath = await writeTape('shelf', tapeFacts('abc1234567', 'https://example.test/a', 'a.mp4'))
    const tapeBytes = await readFile(tapePath, 'utf8')

    await expect(read()).rejects.toMatchObject({ name: 'RefusedFileError', path, reason: 'unreadable' })
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(await readFile(tapePath, 'utf8')).toBe(tapeBytes)
    expect((await readdir(dir)).sort()).toEqual(['shelf', 'shelf.json'])
  })

  it('keeps the first of two tapes whose ids would share a folder and names the other', async () => {
    // One in each area, so even a case-insensitive drive holds both.
    await writeTape('inbox', tapeFacts('abc1234567', 'https://example.test/a', 'First.mp4'))
    const second = tapeFacts('ABC1234567', 'https://example.test/b', 'Second.mp4')
    const secondText = JSON.stringify({ ...header('tape'), ...second })
    const secondPath = await writeTape('shelf', second, secondText)

    const { session, damaged } = await read()

    expect(session.tapes.map((tape) => tape.id)).toEqual(['abc1234567'])
    expect(damaged).toEqual([{ id: 'ABC1234567', path: secondPath, reason: expect.stringMatching(/twice/), newer: false }])
    expect(await readFile(secondPath, 'utf8')).toBe(secondText)
  })
})

describe('tape files without a header', () => {
  it('reports a tape.json without its header as damaged and leaves it as it is', async () => {
    const tape = tapeFacts('abc1234567', 'https://example.test/video', 'video.mp4')
    const bytes = JSON.stringify(tape)
    const path = await writeTape('inbox', tape, bytes)
    const loaded = await read()
    expect(loaded.session.tapes).toEqual([])
    expect(loaded.damaged).toEqual([{ id: 'abc1234567', path, reason: expect.stringMatching(/no format header/), newer: false }])
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })
})

describe('refused tapes on the Shelf', () => {
  it('names a newer tape file as newer', async () => {
    const tape = tapeFacts('abc1234567', 'https://example.test/video', 'video.mp4')
    const path = await writeTape('shelf', tape, JSON.stringify({ ...header('tape', 2), ...tape }))
    expect((await read()).damaged).toEqual([{ id: 'abc1234567', path, reason: expect.stringMatching(/newer/), newer: true }])
  })

  it('holds the box and place of a shelved tape whose file was refused', async () => {
    await writeFile(join(dir, 'shelf.json'), JSON.stringify({
      ...header('shelf'),
      boxes: [{ id: 'box1234567', name: 'Box', tapeIds: ['live000001', 'refused001', 'live000002'] }],
      loose: ['refused002'],
    }))
    await writeTape('shelf', tapeFacts('live000001', 'https://example.test/1', '1.mp4'))
    await writeTape('shelf', tapeFacts('live000002', 'https://example.test/2', '2.mp4'))
    await writeTape('shelf', tapeFacts('refused001', 'https://example.test/r1', 'r1.mp4'), '{ broken')
    const newer = tapeFacts('refused002', 'https://example.test/r2', 'r2.mp4')
    await writeTape('shelf', newer, JSON.stringify({ ...header('tape', 2), ...newer }))

    const { held } = await read()
    expect(held).toEqual([{ id: 'refused001', boxId: 'box1234567', index: 1 }, { id: 'refused002', boxId: null, index: 0 }])
  })
})
