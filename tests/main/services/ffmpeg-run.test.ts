import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

// Node stands in for ffmpeg: the service's own args reach `-e <script> --` as
// plain arguments.
const { writeRecord, script } = vi.hoisted(() => ({ writeRecord: vi.fn(), script: { text: '' } }))
vi.mock('@main/io/records', () => ({ writeRecord }))
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
  it('records both streams whole with the exit code once the run ends', async () => {
    writeRecord.mockClear()
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
      stdout: 'out',
      stderr: stderrText,
    })
    expect(JSON.parse(row.args)).toEqual(args)
  })
})

describe('probeMedia', () => {
  it('records the run with its tape and reads the media details from stderr', async () => {
    writeRecord.mockClear()
    const info = 'Duration: 00:01:05.50, start: 0.000000, bitrate: 512 kb/s'
    script.text = `process.stderr.write(${JSON.stringify(info)}); process.exit(1)`

    const media = await probeMedia('t1', '/library/clip.mp4')

    expect(media).toMatchObject({ durationSeconds: 65.5, bitrateKbps: 512 })
    expect(writeRecord).toHaveBeenCalledOnce()
    const [table, row] = writeRecord.mock.calls[0]!
    expect(table).toBe('ffmpeg_runs')
    expect(row).toMatchObject({ tape_id: 't1', kind: 'probe', exit_code: 1, stderr: info })
    expect(JSON.parse(row.args)).toEqual(['-hide_banner', '-i', '/library/clip.mp4'])
  })
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
