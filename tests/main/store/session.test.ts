import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSessionFile } from '@main/store/session'

// Real filesystem (a temp dir) so the read → parse → quarantine path is exercised
// end to end. loadSessionFile is the path-taking seam the app singleton wraps.

let dir: string

function catalogTape(id: string, sourceUrl: string, filename: string): Record<string, unknown> {
  return {
    id, sourceUrl, state: 'downloaded', addedAtUtc: '2026-01-01T00:00:00.000Z',
    sourceId: id, extractor: 'test', title: 'Tape', uploader: null, durationSeconds: 1,
    chapterCount: 0, probedAtUtc: '2026-01-01T00:00:00.000Z', filename,
    sidecarFilename: `${id}.json`, thumbnailFilename: null, downloadStartedAtUtc: null,
    downloadedAtUtc: '2026-01-01T00:00:00.000Z', name: null, renamedAtUtc: null,
    archivedAtUtc: null, boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, lastError: null,
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-session-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadSessionFile', () => {
  it('returns an empty session when the file is missing', async () => {
    const { result, session } = await loadSessionFile(join(dir, 'catalog.json'))

    expect(result.status).toBe('empty')
    expect(session).toEqual({ tapes: [], boxes: [] })
  })

  it('loads a valid catalog file', async () => {
    const path = join(dir, 'catalog.json')
    await writeFile(path, JSON.stringify({ tapes: [], boxes: [] }))

    const { result } = await loadSessionFile(path)

    expect(result.status).toBe('loaded')
  })

  it('sets aside an unparseable file and starts empty without destroying it', async () => {
    const path = join(dir, 'catalog.json')
    const corrupt = '{ this is not valid json'
    await writeFile(path, corrupt)

    const { result, session } = await loadSessionFile(path)

    expect(result.status).toBe('recovered')
    expect(session).toEqual({ tapes: [], boxes: [] })

    // The original bytes are preserved in a timestamped `catalog-<stamp>.invalid` sibling, not deleted...
    const files = await readdir(dir)
    const quarantined = files.find((f) => f.startsWith('catalog-') && f.endsWith('.invalid'))
    expect(quarantined).toBeDefined()
    expect(await readFile(join(dir, quarantined!), 'utf8')).toBe(corrupt)
    // ...and catalog.json itself has been moved aside (so a later write starts fresh).
    expect(files).not.toContain('catalog.json')
  })

  it('sets aside a schema-invalid file rather than wiping it (one bad tape fails the whole load)', async () => {
    const path = join(dir, 'catalog.json')
    await writeFile(path, JSON.stringify({ tapes: [{ id: 'x', sourceUrl: 'not-a-url' }], boxes: [] }))

    const { result } = await loadSessionFile(path)

    expect(result.status).toBe('recovered')
    const files = await readdir(dir)
    expect(files.some((f) => f.startsWith('catalog-') && f.endsWith('.invalid'))).toBe(true)
  })

  it('sets aside a legacy catalog whose tape bundles contain portable filename aliases', async () => {
    const path = join(dir, 'catalog.json')
    const legacy = JSON.stringify({
      tapes: [
        catalogTape('abc1234567', 'https://example.test/a', 'Caf\u00e9.MP4'),
        catalogTape('def1234567', 'https://example.test/b', 'Cafe\u0301.mp4'),
      ],
      boxes: [],
    })
    await writeFile(path, legacy)

    const { result, session } = await loadSessionFile(path)

    expect(result.status).toBe('recovered')
    expect(session).toEqual({ tapes: [], boxes: [] })
    const quarantined = (await readdir(dir)).find((name) => name.endsWith('.invalid'))
    expect(quarantined).toBeDefined()
    expect(await readFile(join(dir, quarantined!), 'utf8')).toBe(legacy)
  })
})
