import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubprocessError } from '@main/io/spawn'

const { writeRecord, userArgs } = vi.hoisted(() => ({ writeRecord: vi.fn(), userArgs: { value: [] as string[] } }))
vi.mock('@main/io/records', () => ({ writeRecord }))
vi.mock('@main/paths', () => ({ binaryPath: () => process.execPath, paths: { bin: '/bin' } }))
vi.mock('@main/services/ytdlp-args', () => ({
  resolveYtdlpArgs: () => [fileURLToPath(new URL('./fixtures/ytdlp-path-grammar.mjs', import.meta.url)), ...userArgs.value],
}))

import { clearStem, download, downloadThumbnail, findThumbnail } from '@main/services/ytdlp'

let root: string
const tapeId = 'TapeID0123'
const sourceUrl = 'https://example.test/video?literal=$TAPEBOX_NAME&template=%(title)s'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tapebox-literal-paths-'))
  writeRecord.mockClear()
  userArgs.value = []
  vi.stubEnv('TAPEBOX_NAME', 'Unrelated')
  vi.stubEnv('TAPEBOX_MANAGED_LIBRARY', 'Unrelated')
  vi.stubEnv('TAPEBOX_TEST_EXPANSION_HOME', join(root, 'expanded-home'))
  vi.stubEnv('TAPEBOX_TEST_THUMBNAIL_RESULT', 'success')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

async function library(name = 'library'): Promise<string> {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  return path
}

for (const flavour of ['posix', 'windows']) {
  describe(`literal paths with ${flavour} expansion`, () => {
    it.each(['$TAPEBOX_NAME', '%TAPEBOX_NAME%', 'percent %(title)s and ~literal', '${TAPEBOX_MANAGED_LIBRARY}', '%TAPEBOX_MANAGED_LIBRARY%', ' spaces at both ends '])('downloads into the literal selected directory %s', async (name) => {
      vi.stubEnv('TAPEBOX_TEST_PATH_FLAVOUR', flavour)
      const dir = await library(name)
      const anotherFile = join(dir, 'regular.mp4')
      await writeFile(anotherFile, 'regular file')
      await writeFile(join(dir, `${tapeId}.part`), 'old retry')

      const result = await download({ tapeId, url: sourceUrl, libraryDir: dir, outputId: tapeId, signal: new AbortController().signal })

      expect(result).toEqual({ mediaPath: join(dir, `${tapeId}.mp4`), infoJsonPath: join(dir, `${tapeId}.info.json`) })
      expect(await readFile(result.mediaPath, 'utf8')).toBe('fixture media')
      expect(JSON.parse(await readFile(result.infoJsonPath, 'utf8'))).toEqual({ url: sourceUrl })
      expect(await readFile(anotherFile, 'utf8')).toBe('regular file')
      expect(await exists(join(dir, `${tapeId}.part`))).toBe(false)
      expect(await findThumbnail(dir, tapeId)).toBe(join(dir, `${tapeId}.webp`))
      expect(writeRecord.mock.calls[0]![1]).toMatchObject({ url: sourceUrl, tape_id: tapeId, kind: 'download', exit_code: 0 })
      expect(writeRecord.mock.calls[0]![1].stdout).toContain(`tapebox-final-filepath:${result.mediaPath}`)
      expect(process.env['TAPEBOX_MANAGED_LIBRARY']).toBe('Unrelated')
    })

    it.each(['%(title)s', '$TAPEBOX_NAME', '%TAPEBOX_NAME%', '~Holiday', 'literal 100% ${TAPEBOX_NAME}'])('fetches an isolated raw poster for literal media stem %s', async (stem) => {
      vi.stubEnv('TAPEBOX_TEST_PATH_FLAVOUR', flavour)
      const dir = await library()
      await writeFile(join(dir, `${stem}.mp4`), 'existing media')
      await writeFile(join(dir, `${stem}.info.json`), 'existing sidecar')
      await writeFile(join(dir, 'Unrelated.webp'), 'protected poster')

      const raw = await downloadThumbnail(tapeId, sourceUrl, dir, new AbortController().signal)

      expect(await readFile(join(dir, 'Unrelated.webp'), 'utf8')).toBe('protected poster')
      expect(raw).not.toBeNull()
      expect(dirname(raw!)).toBe(dir)
      expect(basename(raw!)).toMatch(/^TapeID0123\.poster-[A-Za-z0-9_-]{10}\.webp$/)
      expect(await readFile(raw!, 'utf8')).toBe('raw poster')
      expect(await readFile(join(dir, `${stem}.mp4`), 'utf8')).toBe('existing media')
      expect(await readFile(join(dir, `${stem}.info.json`), 'utf8')).toBe('existing sidecar')
      expect(writeRecord.mock.calls[0]![1]).toMatchObject({ url: sourceUrl, tape_id: tapeId, kind: 'thumbnail', exit_code: 0 })
      expect(writeRecord.mock.calls[0]![1].stdout).toContain(raw)
    })

    it('retains inherited cwd and intentionally authored relative/environment cookie options', async () => {
      vi.stubEnv('TAPEBOX_TEST_PATH_FLAVOUR', flavour)
      const dir = await library('$TAPEBOX_NAME')
      const cookieDir = join(root, 'cookies with spaces')
      await mkdir(cookieDir)
      await writeFile(join(cookieDir, 'cookies.txt'), 'fixture cookie file')
      vi.stubEnv('TAPEBOX_AUTHORED_COOKIE_ROOT', relative(process.cwd(), cookieDir))
      const cookieArgument = '${TAPEBOX_AUTHORED_COOKIE_ROOT}/cookies.txt'
      const headerArgument = 'Accept-Language: literal $TAPEBOX_NAME %(title)s'
      userArgs.value = ['--cookies', cookieArgument, '--add-header', headerArgument]

      const raw = await downloadThumbnail(tapeId, sourceUrl, dir, new AbortController().signal)

      expect(raw).not.toBeNull()
      const row = writeRecord.mock.calls[0]![1]
      const recordedArgs = JSON.parse(row.args) as string[]
      expect(recordedArgs.slice(1, 5)).toEqual(userArgs.value)
      const firstLine = (row.stdout as string).split('\n')[0]!
      expect(JSON.parse(firstLine.slice('[fixture] '.length))).toEqual({ cwd: process.cwd(), pid: expect.any(Number), cookies: '[REDACTED]', header: headerArgument, url: sourceUrl })
    })

    it('keeps inherited environment values from redirecting raw posters outside the managed library', async () => {
      vi.stubEnv('TAPEBOX_TEST_PATH_FLAVOUR', flavour)
      const outsideStem = join(root, 'outside', 'escaped')
      vi.stubEnv('TAPEBOX_NAME', outsideStem)
      const dir = await library()
      const outside = outsideStem + '.webp'
      await mkdir(dirname(outside))
      await writeFile(outside, 'protected outside poster')

      const raw = await downloadThumbnail(tapeId, sourceUrl, dir, new AbortController().signal)

      expect(await readFile(outside, 'utf8')).toBe('protected outside poster')
      expect(raw).not.toBeNull()
      expect(dirname(raw!)).toBe(dir)
    })
  })
}

describe('raw poster scratch ownership', () => {
  it('keeps concurrent raw results for the same tape separate', async () => {
    vi.stubEnv('TAPEBOX_TEST_PATH_FLAVOUR', 'posix')
    const dir = await library()
    const signal = new AbortController().signal
    const [first, second] = await Promise.all([
      downloadThumbnail(tapeId, sourceUrl, dir, signal),
      downloadThumbnail(tapeId, sourceUrl, dir, signal),
    ])
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first).not.toBe(second)
    expect(await readFile(first!, 'utf8')).toBe('raw poster')
    expect(await readFile(second!, 'utf8')).toBe('raw poster')
    await clearStem(dir, basename(first!, '.webp'))
    expect(await exists(first!)).toBe(false)
    expect(await readFile(second!, 'utf8')).toBe('raw poster')
  })

  it('removes only its own raw scratch after the provider has failed', async () => {
    vi.stubEnv('TAPEBOX_TEST_PATH_FLAVOUR', 'posix')
    vi.stubEnv('TAPEBOX_TEST_THUMBNAIL_RESULT', 'fail')
    const dir = await library()
    const unrelated = join(dir, `${tapeId}.poster-kept.webp`)
    await writeFile(unrelated, 'previous raw poster')
    await writeFile(join(dir, 'regular.webp'), 'regular poster')

    await expect(downloadThumbnail(tapeId, sourceUrl, dir, new AbortController().signal)).rejects.toBeInstanceOf(SubprocessError)

    expect((await readdir(dir)).sort()).toEqual([`${tapeId}.poster-kept.webp`, 'regular.webp'].sort())
    expect(await readFile(unrelated, 'utf8')).toBe('previous raw poster')
    expect(writeRecord.mock.calls[0]![1]).toMatchObject({ kind: 'thumbnail', exit_code: 1, stderr: 'ERROR: fixture thumbnail failure\n' })
  })

  it('removes its scratch after a parked provider has physically stopped on abort', async () => {
    vi.stubEnv('TAPEBOX_TEST_PATH_FLAVOUR', 'posix')
    vi.stubEnv('TAPEBOX_TEST_THUMBNAIL_RESULT', 'park')
    const dir = await library()
    const controller = new AbortController()
    const result = downloadThumbnail(tapeId, sourceUrl, dir, controller.signal)
    const observed = result.then(() => 'resolved', (err: unknown) => err)
    // A real child under the loaded default suite can take well over waitFor's default second to start.
    await vi.waitFor(async () => expect((await readdir(dir)).length).toBeGreaterThan(0), { timeout: 10_000 })
    controller.abort(new DOMException('cancel poster', 'AbortError'))

    expect(await observed).toMatchObject({ name: 'AbortError' })
    expect(await readdir(dir)).toEqual([])
    expect(writeRecord).toHaveBeenCalledOnce()
    const firstLine = (writeRecord.mock.calls[0]![1].stdout as string).split('\n')[0]!
    const { pid } = JSON.parse(firstLine.slice('[fixture] '.length)) as { pid: number }
    expect(() => process.kill(pid, 0)).toThrow()
  }, 20_000)

  it('returns null for a missing optional poster and leaves existing files intact', async () => {
    vi.stubEnv('TAPEBOX_TEST_PATH_FLAVOUR', 'posix')
    vi.stubEnv('TAPEBOX_TEST_THUMBNAIL_RESULT', 'missing')
    const dir = await library()
    await writeFile(join(dir, 'Holiday.mp4'), 'existing media')

    await expect(downloadThumbnail(tapeId, sourceUrl, dir, new AbortController().signal)).resolves.toBeNull()

    expect(await readdir(dir)).toEqual(['Holiday.mp4'])
    expect(writeRecord.mock.calls[0]![1]).toMatchObject({ kind: 'thumbnail', exit_code: 0, stderr: 'WARNING: no thumbnail available\n' })
  })
})
