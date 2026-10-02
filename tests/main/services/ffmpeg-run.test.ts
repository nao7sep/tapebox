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

const { collectRun, probeMedia } = await import('@main/services/ffmpeg')
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
