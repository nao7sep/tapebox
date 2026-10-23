import { describe, expect, it, vi } from 'vitest'
import type { SubprocessError } from '@main/io/spawn'

vi.mock('@main/io/logger', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
const { writeRecord, writeOutputChunk, script } = vi.hoisted(() => ({ writeRecord: vi.fn(), writeOutputChunk: vi.fn(), script: { value: 'setInterval(() => {}, 1000)' } }))
vi.mock('@main/io/records', () => ({ writeRecord, writeOutputChunk }))
// The scan's "yt-dlp" is Node waiting until it is stopped; its own flags follow `--`.
vi.mock('@main/paths', () => ({ binaryPath: () => process.execPath, paths: { bin: '/bin' } }))
vi.mock('@main/services/ytdlp-args', () => ({ resolveYtdlpArgs: () => ['-e', script.value, '--'] }))

const { scanOutcome, startScan } = await import('@main/services/ytdlp-scan')

const ended = { aborted: false, failure: null, exitCode: 0, totalCount: 0, stderr: '' }

describe('scanOutcome', () => {
  it('reports a clean exit as done, even with nothing listed', () => {
    expect(scanOutcome({ ...ended, totalCount: 0 })).toEqual({ kind: 'done', totalCount: 0 })
  })

  it('treats a stopped scan as stopped, never as a failure', () => {
    expect(scanOutcome({ ...ended, aborted: true, failure: new Error('aborted'), exitCode: null, totalCount: 4 }))
      .toEqual({ kind: 'stopped', totalCount: 4 })
  })

  it('keeps the entries a scan listed before yt-dlp failed', () => {
    expect(scanOutcome({ ...ended, exitCode: 1, totalCount: 12 })).toMatchObject({ kind: 'failed' })
    expect(scanOutcome({ ...ended, failure: new Error('idle'), exitCode: null, totalCount: 3 }))
      .toMatchObject({ kind: 'failed' })
  })

  it('reports a failed exit with nothing listed as a failure carrying yt-dlp reason', () => {
    const outcome = scanOutcome({ ...ended, exitCode: 1, stderr: 'ERROR: Unsupported URL' })
    expect(outcome.kind).toBe('failed')
    expect((outcome as { error: SubprocessError }).error.stderr).toBe('ERROR: Unsupported URL')

    const idle = new Error('no output')
    expect(scanOutcome({ ...ended, failure: idle, exitCode: null })).toEqual({ kind: 'failed', error: idle })
  })
})

describe('stopping a scan', () => {
  it.each(['cancel', 'quit'] as const)('records a scan stopped for %s with that reason', async (by) => {
    writeRecord.mockClear()
    writeOutputChunk.mockClear()
    const scan = startScan('https://example.com/list', 's1', () => {})
    scan.cancel(by)

    await expect(scan.complete).resolves.toEqual({ kind: 'stopped', totalCount: 0 })
    expect(writeRecord).toHaveBeenCalledOnce()
    expect(writeRecord.mock.calls[0]![1]).toMatchObject({ kind: 'scan', scan_id: 's1', stop_reason: by })
  })
})


describe('stream delivery', () => {
  it('awaits each stored entry and drains the final UTF-8 line before completing', async () => {
    script.value = `for (let i=0;i<600;i++) process.stdout.write(JSON.stringify({id:String(i),url:'https://example.test/'+i,title:'日本語'})+'\\n')`
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const found: string[] = []
    const scan = startScan('https://example.test/list', 'stream', async entry => {
      found.push(entry.title!)
      if (found.length === 1) await held
    })
    await vi.waitFor(() => expect(found).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(found).toHaveLength(1)
    release()
    await expect(scan.complete).resolves.toEqual({ kind: 'done', totalCount: 600 })
    expect(found).toHaveLength(600)
    expect(found.every(title => title === '日本語')).toBe(true)
  })
  it('reports a store failure and stops the producer rather than swallowing it as malformed JSON', async () => {
    script.value = `process.stdout.write(JSON.stringify({id:'1',url:'https://example.test/1'})+'\\n'); setInterval(()=>{},1000)`
    const failure = new Error('result disk full')
    const scan = startScan('https://example.test/list', 'failed', async () => { throw failure })
    await expect(scan.complete).resolves.toEqual({ kind: 'failed', error: failure })
  })
})
