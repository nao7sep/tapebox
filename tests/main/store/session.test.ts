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

  it('sets aside an unparseable shelf file without destroying it, and keeps every tape', async () => {
    const path = join(dir, 'shelf.json')
    const corrupt = '{ this is not valid json'
    await writeFile(path, corrupt)
    await writeTape('shelf', tapeFacts('abc1234567', 'https://example.test/a', 'a.mp4'))

    const { result, session, shelfWritten } = await read()

    expect(result.status).toBe('recovered')
    expect(shelfWritten).toBe(false)
    // The shelved tape is still there, now among the loose tapes.
    expect(session.tapes).toMatchObject([{ id: 'abc1234567', shelved: true, boxId: null }])

    // The original bytes are preserved in a timestamped `shelf-<stamp>.invalid` sibling, not deleted...
    const files = await readdir(dir)
    const quarantined = files.find((f) => f.startsWith('shelf-') && f.endsWith('.invalid'))
    expect(quarantined).toBeDefined()
    expect(await readFile(join(dir, quarantined!), 'utf8')).toBe(corrupt)
    // ...and shelf.json itself has been moved aside (so a later write starts fresh).
    expect(files).not.toContain('shelf.json')
  })

  it('sets aside a schema-invalid shelf file rather than wiping it', async () => {
    const path = join(dir, 'shelf.json')
    await writeFile(path, JSON.stringify({ ...header('shelf'), boxes: [{ id: 'x' }], loose: [] }))

    const { result } = await read()

    expect(result.status).toBe('recovered')
    const files = await readdir(dir)
    expect(files.some((f) => f.startsWith('shelf-') && f.endsWith('.invalid'))).toBe(true)
  })

  it('keeps the first of two tapes whose ids would share a folder and names the other', async () => {
    // One in each area, so even a case-insensitive drive holds both.
    await writeTape('inbox', tapeFacts('abc1234567', 'https://example.test/a', 'First.mp4'))
    const second = tapeFacts('ABC1234567', 'https://example.test/b', 'Second.mp4')
    const secondText = JSON.stringify({ ...header('tape'), ...second })
    const secondPath = await writeTape('shelf', second, secondText)

    const { session, damaged } = await read()

    expect(session.tapes.map((tape) => tape.id)).toEqual(['abc1234567'])
    expect(damaged).toEqual([{ id: 'ABC1234567', path: secondPath, reason: expect.stringMatching(/twice/) }])
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
    expect(loaded.damaged).toEqual([{ id: 'abc1234567', path, reason: expect.stringMatching(/no format header/) }])
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })
})
