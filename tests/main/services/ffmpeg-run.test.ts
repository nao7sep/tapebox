import { describe, expect, it, vi } from 'vitest'

const { writeRecord } = vi.hoisted(() => ({ writeRecord: vi.fn() }))
vi.mock('@main/io/records', () => ({ writeRecord }))
vi.mock('@main/paths', () => ({ binaryPath: () => '/bin/ffmpeg', paths: { bin: '/bin' } }))

const { collectRun } = await import('@main/services/ffmpeg')
const { spawnStreaming, waitForExit } = await import('@main/io/spawn')

describe('collectRun', () => {
  it('records both streams whole with the exit code once the run ends', async () => {
    const stderrText = Array.from({ length: 200 }, (_, i) => `frame=${i} ✓`).join('\r')
    const script = `process.stdout.write('out'); process.stderr.write(${JSON.stringify(stderrText)}); process.exit(1)`
    const args = ['-e', script]
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
