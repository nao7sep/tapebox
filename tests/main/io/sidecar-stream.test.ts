import { createWriteStream, statSync, watch } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projectSidecar, rewriteSidecarStage } from '@main/io/sidecar-stream'
import { finalize, readSidecarDocument, rewriteSidecar } from '@main/core/sidecar'
import { classifyImport } from '@main/core/import-classify'
import { maskUrlCredentials, maskYtdlpOutput } from '@main/io/mask'
import type { SidecarTapeBox } from '@shared/domain'

let dir: string
const AT = '2026-01-01T00:00:00.000Z'
const BOX: SidecarTapeBox = {
  sourceUrl: 'https://example.test/watch', name: 'Take', addedAtUtc: AT, downloadedAtUtc: AT,
  renamedAtUtc: null, media: null, mediaFilename: 'Take.mp4', thumbnailFilename: null,
}
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tapebox-sidecar-stream-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function document(value: unknown, name = 'Take.json'): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, JSON.stringify(value))
  return path
}
async function json(path: string): Promise<Record<string, unknown>> { return JSON.parse(await readFile(path, 'utf8')) }

/** A generated opaque string is written chunk by chunk, never assembled into a
 * large input object/string in the test. The suffix can deliberately fail late. */
async function opaqueDocument(path: string, suffix = '}'): Promise<void> {
  const chunk = 'opaque-provider-metadata-'.repeat(2048)
  async function* chunks() {
    yield JSON.stringify({ formatVersion: 1, id: 'source', tapebox: BOX }).slice(0, -1) + ',"opaque":"'
    for (let index = 0; index < 128; index++) yield chunk
    yield '"' + suffix
  }
  await pipeline(chunks(), createWriteStream(path))
}

describe('projectSidecar', () => {
  it('retains consumed fields and chapter positions while omitting opaque metadata at each level', async () => {
    const consumed = {
      formatVersion: 1, id: 'source', extractor: 'Example', title: 'Title', uploader: 'Uploader', duration: 42,
      description: 'Description', ext: 'mp4', vcodec: 'h264', acodec: 'aac', width: 1920, height: 1080,
      fps: 30, filesize: 12345, filesize_approx: 12000,
      tapebox: { ...BOX, media: { vcodec: 'h264', acodec: 'aac', width: 1920, height: 1080, fps: 30, durationSeconds: 42 } },
      chapters: [{ title: 'Opening', start_time: 0, end_time: 12 }, { title: 'Main', start_time: 12, end_time: 42 }],
    }
    const path = await document({
      ...consumed, opaque: { nested: ['provider', 'data'] }, formats: [{ id: 'format', opaque: 'unused' }],
      tapebox: { ...consumed.tapebox, extra: { opaque: 'unused' }, media: { ...consumed.tapebox.media, extra: ['unused'] } },
      chapters: consumed.chapters.map((chapter) => ({ ...chapter, extra: { unused: true } })),
    })
    const projected = await projectSidecar(path)
    expect(projected.value).toEqual(consumed)
    expect(projected.stamp).toBeTruthy()
    expect((await projectSidecar(path)).stamp).toBe(projected.stamp)
  })

  it('projects a sizeable streamed opaque value without returning that value', async () => {
    const path = join(dir, 'Large.json')
    await opaqueDocument(path)
    expect((await stat(path)).size).toBeGreaterThan(6_000_000)
    expect((await projectSidecar(path)).value).toEqual({ formatVersion: 1, id: 'source', tapebox: BOX })
  })

  it('omits sizeable opaque strings from roots, namespace, media and chapters', async () => {
    const path = join(dir, 'NestedLarge.json')
    const chunk = 'opaque-nested-metadata-'.repeat(2048)
    async function* chunks() {
      const prefixes = [
        '{"formatVersion":1,"id":"source","opaque":"',
        '","tapebox":' + JSON.stringify(BOX).slice(0, -1) + ',"opaque":"',
        '","media":{"width":1920,"opaque":"',
        '"}},"chapters":[{"title":"Opening","start_time":0,"end_time":12,"opaque":"',
      ]
      for (const prefix of prefixes) {
        yield prefix
        for (let index = 0; index < 40; index++) yield chunk
      }
      yield '"}]}'
    }
    await pipeline(chunks(), createWriteStream(path))
    expect((await stat(path)).size).toBeGreaterThan(6_000_000)
    expect((await projectSidecar(path)).value).toEqual({ formatVersion: 1, id: 'source', tapebox: { ...BOX, media: { width: 1920 } }, chapters: [{ title: 'Opening', start_time: 0, end_time: 12 }] })
  })

  it.each([
    null, [], 'not a document',
    { formatVersion: 1, tapebox: 'wrong' },
    { formatVersion: 1, tapebox: [] },
    { formatVersion: 1, tapebox: null },
    { formatVersion: 1, title: {}, tapebox: BOX },
    { formatVersion: 1, duration: 'forty-two', tapebox: BOX },
    { formatVersion: 1, chapters: { title: 'not an array' }, tapebox: BOX },
    { formatVersion: 1, tapebox: { ...BOX, name: [] } },
    { formatVersion: 1, tapebox: { ...BOX, sourceUrl: {} } },
    { formatVersion: 1, tapebox: { ...BOX, mediaFilename: ['Take.mp4'] } },
  ])('preserves malformed critical shapes for the real admission boundary: %j', async (value) => {
    const path = await document(value)
    const projected = await projectSidecar(path)
    expect(classifyImport(projected.value)).toEqual(classifyImport(value))
    expect(classifyImport(projected.value).status).toBe('reject')
  })

  it.each(['catalog', 'metadata', 'description', 'version'] as const)('projects only the fields required by %s mode and counts original chapter entries', async (mode) => {
    const chapters = [{}, null, { nested: { entries: [1, 2, { title: 'nested' }] } }, 'chapter string', [], [null, {}], 42, false]
    const source = { formatVersion: 1, id: 'source', title: 'Title', description: 'Full description', tapebox: BOX, chapters, opaque: { chapters: [1, 2, 3] } }
    const path = await document(source)
    const projected = await projectSidecar(path, undefined, mode)
    const expected = {
      catalog: { formatVersion: 1, id: 'source', title: 'Title', tapebox: BOX, chapters: [] },
      metadata: { formatVersion: 1, id: 'source', title: 'Title', description: 'Full description', tapebox: BOX, chapters: [] },
      description: { formatVersion: 1, description: 'Full description' },
      version: { formatVersion: 1 },
    }
    expect(projected.value).toEqual(expected[mode])
    expect(projected.chapterCount).toBe(chapters.length)
    expect(projected.stamp).toBe((await projectSidecar(path)).stamp)
  })

  it.each([
    ['[{},{"nested":[1,2]},null,"old"]', '[{},null,{"nested":{"child":[1,2,3]}},"new"]', 4],
    ['[{},{},null]', '[]', 0],
    ['[]', '[{},"one"]', 2],
    ['[{},null]', 'null', null],
    ['null', '[{},null,"last"]', 3],
    ['[{},{},null]', '{"not":"an array"}', null],
  ] as const)('uses the last duplicate chapter property for its count (%s then %s)', async (first, last, chapterCount) => {
    const path = join(dir, 'Duplicate.json')
    await writeFile(path, `{"formatVersion":1,"chapters":${first},"unrelated":{"chapters":[1,2,3,4,5]},"chapters":${last}}`)
    for (const mode of ['preview', 'catalog', 'metadata', 'description', 'version'] as const) {
      const projected = await projectSidecar(path, undefined, mode)
      expect(projected.chapterCount).toBe(chapterCount)
      if (mode === 'catalog' || mode === 'metadata') {
        const value: unknown = JSON.parse(last)
        const expectedShape = Array.isArray(value) ? [] : value !== null && typeof value === 'object' ? {} : value
        expect((projected.value as Record<string, unknown>).chapters).toEqual(expectedShape)
      }
    }
  })

  it.each([{}, { chapters: null }, { chapters: 'not an array' }, { chapters: { title: 'not an array' } }])('reports no chapter count when the root contains no chapter array: %j', async (value) => {
    const path = await document({ formatVersion: 1, ...value, opaque: { chapters: [1, 2, 3] } })
    expect((await projectSidecar(path, undefined, 'catalog')).chapterCount).toBeNull()
  })

  it('preserves invalid media types and the count and types of chapter entries', async () => {
    const path = await document({ tapebox: { ...BOX, media: [] }, chapters: [null, 'invalid', 1, false, { title: 'Valid', opaque: 'omitted' }] })
    expect((await projectSidecar(path)).value).toEqual({ tapebox: { ...BOX, media: [] }, chapters: [null, 'invalid', 1, false, { title: 'Valid' }] })
  })
})

describe('rewriteSidecarStage', () => {
  it('applies root and namespace patches while retaining unknown nested metadata', async () => {
    const original = {
      formatVersion: 1, id: 'source', title: 'Old title', rootExtra: { future: [{ key: 'retained' }] },
      formats: [{ format_id: 'one', future: { urls: ['https://media.test/v'] } }],
      tapebox: { ...BOX, future: { nested: ['retained'] }, media: { vcodec: 'h264', future: { retained: true } } },
    }
    const source = await document(original)
    const output = join(dir, 'stage.json')
    const { stamp } = await projectSidecar(source)
    await rewriteSidecarStage(source, output, { root: { title: 'New title', added: { flag: true } }, tapebox: { name: 'Renamed', mediaFilename: 'Renamed.mp4' } }, 1, stamp)
    expect(await json(output)).toEqual({ ...original, title: 'New title', added: { flag: true }, tapebox: { ...original.tapebox, name: 'Renamed', mediaFilename: 'Renamed.mp4' } })
    expect(Object.keys(await json(output))[0]).toBe('formatVersion')
    expect(await json(source)).toEqual(original)
  })

  it('can create a namespace and replace a full root field without keeping old child fields', async () => {
    const source = await document({ title: 'Title', replace: { old: true }, opaque: 'kept' })
    const output = join(dir, 'stage.json')
    await rewriteSidecarStage(source, output, { root: { replace: [1, null, true, false, 'new'] }, tapebox: BOX }, 1)
    expect(await json(output)).toEqual({ formatVersion: 1, title: 'Title', replace: [1, null, true, false, 'new'], opaque: 'kept', tapebox: BOX })
  })

  it('strips source filesystem paths during finalization and retains unrelated nested fields', async () => {
    const paths = { filename: '/source/a', _filename: '/source/b', filepath: '/source/c', _filepath: '/source/d', __finaldir: '/source', __files_to_move: { a: 'b' }, requested_downloads: [{ filepath: '/source/e' }] }
    const source = await document({ ...paths, id: 'source', formats: [{ filepath: '/source/f', format_id: 'f', future: { filepath: 'opaque-keep' } }], requested_formats: [{ filepath: '/source/g', format_id: 'g' }], unknown: { filepath: 'opaque-keep' }, tapebox: { old: 'replaced' } }, 'source.info.json')
    const output = join(dir, 'Take.json')
    await finalize({ infoJsonPath: source, sidecarPath: output, tapeboxAdditions: BOX })
    expect(await json(output)).toEqual({ formatVersion: 1, id: 'source', formats: [{ format_id: 'f', future: { filepath: 'opaque-keep' } }], requested_formats: [{ format_id: 'g' }], unknown: { filepath: 'opaque-keep' }, tapebox: BOX })
    await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves non-array format metadata during path stripping', async () => {
    const formats = { custom: { filepath: 'opaque-keep' } }
    const source = await document({ formats })
    const output = join(dir, 'stage.json')
    await rewriteSidecarStage(source, output, { stripPaths: true }, 1)
    expect(await json(output)).toEqual({ formatVersion: 1, formats })
  })

  it('masks credential fields and URL strings across parser chunks without losing opaque fields', async () => {
    const prefix = 'ordinary '.repeat(8192)
    const original = {
      title: 'Title', cookies: 'sid=' + 'cookie-secret'.repeat(12000),
      'https://name:password@keys.test/v?sig=key-secret': 'retained',
      formats: [{ http_headers: { Authorization: 'Bearer ' + 'auth-secret'.repeat(12000), Cookie: 'cookie-header', 'Proxy-Authorization': 'Basic proxy-secret', Accept: 'video/*' },
        url: `${prefix}https://name:password@media.test/v?sig=${'signed-secret'.repeat(12000)}&keep=yes#chapter` }],
      tapebox: { ...BOX, future: { url: 'socks5://name:password@proxy.test:8080' } },
    }
    const source = await document(original)
    const output = join(dir, 'stage.json')
    await rewriteSidecarStage(source, output, { mask: true }, 1)
    expect(await json(output)).toEqual({ formatVersion: 1, ...JSON.parse(maskUrlCredentials(maskYtdlpOutput(JSON.stringify(original)))) })
    expect(await readFile(output, 'utf8')).not.toMatch(/cookie-secret|auth-secret|signed-secret|password|proxy-secret/)
  })

  it('masks secrets introduced by a namespace patch as well as those in the source', async () => {
    const source = await document({ tapebox: BOX })
    const output = join(dir, 'stage.json')
    const sourceUrl = 'https://name:password@media.test/watch?sig=signature-secret&keep=yes'
    await rewriteSidecarStage(source, output, { root: { cookie: 'root-cookie-secret', description: 'https://root:password@root.test/v?pot=root-proof' }, tapebox: { sourceUrl }, mask: true }, 1)
    expect(await json(output)).toEqual({ formatVersion: 1, cookie: '[REDACTED]', description: 'https://[REDACTED]@root.test/v?pot=[REDACTED]', tapebox: { ...BOX, sourceUrl: 'https://[REDACTED]@media.test/watch?sig=[REDACTED]&keep=yes' } })
  })
})

describe('sidecar publication and failure boundaries', () => {
  it('keeps the destination and source intact after malformed JSON is discovered late', async () => {
    const source = join(dir, 'source.info.json')
    await opaqueDocument(source, ',"late":]')
    const output = join(dir, 'Take.json')
    await writeFile(output, 'previous destination')
    await expect(finalize({ infoJsonPath: source, sidecarPath: output, tapeboxAdditions: BOX })).rejects.toThrow()
    expect(await readFile(output, 'utf8')).toBe('previous destination')
    expect((await stat(source)).size).toBeGreaterThan(6_000_000)
    expect((await readdir(dir)).sort()).toEqual(['Take.json', 'source.info.json'])
  })

  it('refuses newer formats at the core read boundary without changing the source', async () => {
    const source = await document({ formatVersion: 2, title: 'Future', opaque: { retained: true } })
    const original = await readFile(source, 'utf8')
    await expect(readSidecarDocument(source)).rejects.toMatchObject({ name: 'UserFacingError', userMessage: { key: 'errors.fileNewer', values: { name: 'Take.json' } } })
    expect(await readFile(source, 'utf8')).toBe(original)
    expect(await readdir(dir)).toEqual(['Take.json'])
  })

  it('refuses an obsolete expectedStamp and preserves the newer file with no stage left over', async () => {
    const source = await document({ title: 'Before', tapebox: BOX })
    const { stamp } = await projectSidecar(source)
    const replacement = JSON.stringify({ title: 'Changed externally', tapebox: BOX })
    await writeFile(source, replacement)
    await expect(rewriteSidecar(source, { root: { title: 'Must not overwrite' } }, stamp)).rejects.toThrow('Sidecar changed before')
    expect(await readFile(source, 'utf8')).toBe(replacement)
    expect(await readdir(dir)).toEqual(['Take.json'])
  })

  it('cancels after a stage receives real output, then removes that stage and preserves the original', async () => {
    const source = join(dir, 'Large.json')
    await opaqueDocument(source)
    const { stamp } = await projectSidecar(source)
    const before = await stat(source)
    const controller = new AbortController()
    let sawWrittenStage = false
    const watcher = watch(dir, { persistent: false }, (_event, name) => {
      if (!name?.endsWith('.tmp') || sawWrittenStage) return
      try {
        if (statSync(join(dir, name)).size === 0) return
        sawWrittenStage = true
        controller.abort()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })
    try {
      await expect(rewriteSidecar(source, { root: { title: 'Must not publish' } }, stamp, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    } finally { watcher.close() }
    expect(sawWrittenStage).toBe(true)
    expect((await stat(source)).size).toBe(before.size)
    expect((await projectSidecar(source)).value).toEqual({ formatVersion: 1, id: 'source', tapebox: BOX })
    expect(await readdir(dir)).toEqual(['Large.json'])
  })
})
