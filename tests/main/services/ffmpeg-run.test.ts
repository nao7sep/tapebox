import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

// Node stands in for ffmpeg: the service's own args reach `-e <script> --` as
// plain arguments.
const { writeRecord, writeOutputChunk, script } = vi.hoisted(() => ({ writeRecord: vi.fn(), writeOutputChunk: vi.fn(), script: { text: '' } }))
vi.mock('@main/io/records', () => ({ writeRecord, writeOutputChunk }))
vi.mock('@main/paths', () => ({ binaryPath: () => process.execPath, paths: { bin: '/bin' } }))
vi.mock('@main/io/spawn', async (importOriginal) => {
  const real = await importOriginal<typeof import('@main/io/spawn')>()
  return {
    ...real,
    spawnStreaming: (command: string, args: readonly string[], opts?: Parameters<typeof real.spawnStreaming>[2]) =>
      real.spawnStreaming(command, script.text ? ['-e', script.text, '--', ...args] : args, opts),
  }
})

const { collectRun, probeMedia, saveThumbnailJpeg } = await import('@main/services/ffmpeg')
const { spawnStreaming, waitForExit } = await import('@main/io/spawn')

describe('collectRun', () => {
  it('streams both outputs with metadata after the run ends', async () => {
    writeRecord.mockClear()
    writeOutputChunk.mockClear()
    script.text = ''
    const stderrText = Array.from({ length: 200 }, (_, i) => `frame=${i} ✓`).join('\r')
    const source = `process.stdout.write('out'); process.stderr.write(${JSON.stringify(stderrText)}); process.exit(1)`
    const args = ['-e', source]
    const child = spawnStreaming(process.execPath, args)
    const run = collectRun(child, { kind: 'thumbnail', tapeId: 't1', args })
    await waitForExit(child, { reject: false })
    expect(run.stderr()).toBe(stderrText)
    run.record()

    expect(writeRecord).toHaveBeenCalledOnce()
    const [table, row] = writeRecord.mock.calls[0]!
    expect(table).toBe('ffmpeg_runs')
    expect(row).toMatchObject({
      tape_id: 't1',
      kind: 'thumbnail',
      exit_code: 1,
      signal: null,
      stop_reason: null,
      stdout: '',
      stderr: '',
    })
    expect(JSON.parse(row.args)).toEqual(args)
    expect(writeOutputChunk.mock.calls.filter((call) => call[1] === 'stderr').map((call) => call[3]).join('')).toBe(stderrText)
  })
})

describe('probeMedia', () => {
  it('records the run with its tape and reads the media details from stderr', async () => {
    writeRecord.mockClear()
    writeOutputChunk.mockClear()
    const info = 'Duration: 00:01:05.50, start: 0.000000, bitrate: 512 kb/s'
    script.text = `process.stderr.write(${JSON.stringify(info)}); process.exit(1)`

    const media = await probeMedia('t1', '/collection/clip.mp4')

    expect(media).toMatchObject({ durationSeconds: 65.5, bitrateKbps: 512 })
    expect(writeRecord).toHaveBeenCalledOnce()
    const [table, row] = writeRecord.mock.calls[0]!
    expect(table).toBe('ffmpeg_runs')
    expect(row).toMatchObject({ tape_id: 't1', kind: 'probe', exit_code: 1, stderr: '' })
    expect(JSON.parse(row.args)).toEqual(['-hide_banner', '-i', '/collection/clip.mp4'])
    expect(writeRecord.mock.calls[0]![5]).toMatchObject({ succeeded: true, elapsedMs: expect.any(Number) })
  })
})

it('rejects unrecognized ffmpeg media and records semantic failure', async () => {
  writeRecord.mockClear()
    writeOutputChunk.mockClear()
  script.text = "process.stderr.write('Invalid data found when processing input'); process.exit(1)"
  await expect(probeMedia('t1', '/collection/not-media.mp4')).rejects.toThrow('did not recognize')
  expect(writeRecord.mock.calls[0]![1]).toMatchObject({ exit_code: 1, kind: 'probe' })
  expect(writeRecord.mock.calls[0]![5]).toMatchObject({ succeeded: false, elapsedMs: expect.any(Number) })
})

describe('thumbnail private staging', () => {
  it.each([true, false])('creates a private empty subprocess output and requires produced bytes (writes=%s)', async (writes) => {
    const root = await mkdtemp(join(tmpdir(), 'tapebox-thumbnail-stage-'))
    const source = join(root, 'source.png')
    const output = join(root, 'Poster.jpg')
    try {
      await writeFile(source, 'source image')
      await writeFile(output, 'original poster')
      script.text = `const fs=require('node:fs'); const path=process.argv.at(-1); const s=fs.statSync(path); if(s.size!==0 || (process.platform!=='win32' && (s.mode & 511)!==384)) throw new Error('output was not private before bytes'); ${writes ? "fs.writeFileSync(path,'new poster')" : ''}`
      if (writes) {
        await expect(saveThumbnailJpeg('t1', source, root, 'Poster')).resolves.toBe('Poster.jpg')
        expect(await readFile(output, 'utf8')).toBe('new poster')
        expect(await readdir(root)).toEqual(['Poster.jpg'])
      } else {
        await expect(saveThumbnailJpeg('t1', source, root, 'Poster')).rejects.toThrow('did not produce a thumbnail')
        expect(await readFile(output, 'utf8')).toBe('original poster')
        expect(await readFile(source, 'utf8')).toBe('source image')
        expect((await readdir(root)).sort()).toEqual(['Poster.jpg', 'source.png'])
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

it('keeps parsed probe metadata after long trailing warnings leave the stderr tail', async () => {
  writeRecord.mockClear()
  writeOutputChunk.mockClear()
  script.text = "process.stderr.write('Duration: 00:01:05.50, bitrate: 512 kb/s\\nStream #0:0: Video: h264, 640x360, 30 fps\\nAudio: aac\\n'); process.stderr.write('warning\\n'.repeat(12000)); process.exit(1)"
  expect(await probeMedia('t1', '/collection/clip.mp4')).toMatchObject({ durationSeconds: 65.5, bitrateKbps: 512, vcodec: 'h264', width: 640, height: 360, fps: 30, acodec: 'aac' })
  expect(writeOutputChunk.mock.calls.filter((call) => call[1] === 'stderr').map((call) => call[3]).join('')).toContain('Duration: 00:01:05.50')
  expect(writeRecord.mock.calls[0]![5]).toMatchObject({ succeeded: true })
})
