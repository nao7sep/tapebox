import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSessionFile } from '@main/store/session'

// Real filesystem (a temp dir) so the read → parse → quarantine path is exercised
// end to end. loadSessionFile is the path-taking seam the app singleton wraps.

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-session-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadSessionFile', () => {
  it('returns an empty session when the file is missing', async () => {
    const { result, session } = await loadSessionFile(join(dir, 'session.json'))

    expect(result.status).toBe('empty')
    expect(session).toEqual({ tapes: [], boxes: [] })
  })

  it('loads a valid session file', async () => {
    const path = join(dir, 'session.json')
    await writeFile(path, JSON.stringify({ tapes: [], boxes: [] }))

    const { result } = await loadSessionFile(path)

    expect(result.status).toBe('loaded')
  })

  it('sets aside an unparseable file and starts empty without destroying it', async () => {
    const path = join(dir, 'session.json')
    const corrupt = '{ this is not valid json'
    await writeFile(path, corrupt)

    const { result, session } = await loadSessionFile(path)

    expect(result.status).toBe('recovered')
    expect(session).toEqual({ tapes: [], boxes: [] })

    // The original bytes are preserved in a timestamped sibling, not deleted...
    const files = await readdir(dir)
    const quarantined = files.find((f) => f.startsWith('session.corrupt-'))
    expect(quarantined).toBeDefined()
    expect(await readFile(join(dir, quarantined!), 'utf8')).toBe(corrupt)
    // ...and session.json itself has been moved aside (so a later write starts fresh).
    expect(files).not.toContain('session.json')
  })

  it('sets aside a schema-invalid file rather than wiping it (one bad tape fails the whole load)', async () => {
    const path = join(dir, 'session.json')
    await writeFile(path, JSON.stringify({ tapes: [{ id: 'x', sourceUrl: 'not-a-url' }], boxes: [] }))

    const { result } = await loadSessionFile(path)

    expect(result.status).toBe('recovered')
    const files = await readdir(dir)
    expect(files.some((f) => f.startsWith('session.corrupt-'))).toBe(true)
  })
})
