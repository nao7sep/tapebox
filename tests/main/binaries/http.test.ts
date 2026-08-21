import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadWithProgress, pumpToFile } from '@main/binaries/http'
import { IdleTimeoutError } from '@main/io/spawn'

// pumpToFile is the streaming core of downloadWithProgress, lifted out so the
// edge cases that used to be impossible to exercise (a write error stranding a
// manual drain await) are testable with in-memory streams — no network, no fs.

/** A web ReadableStream that emits the given chunks then closes. */
function bodyOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
}

/** A web ReadableStream that emits one chunk and then never produces another
 *  (stays open, no further data) — the shape an idle watchdog must catch. */
function stallingBodyAfter(chunk: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk)
    },
    // no pull / no close: the stream is alive but silent
  })
}

/** A web ReadableStream that emits one chunk every gapMs, then closes — a
 *  slow-but-alive transfer that should keep re-kicking the idle watchdog. */
function dripBody(chunks: Uint8Array[], gapMs: number): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (i < chunks.length) controller.enqueue(chunks[i++]!)
          else controller.close()
          resolve()
        }, gapMs)
      })
    },
  })
}

/** A Writable that records every chunk it is handed. */
function collector(chunks: Buffer[], opts: { delayMs?: number; highWaterMark?: number } = {}): Writable {
  return new Writable({
    highWaterMark: opts.highWaterMark,
    write(chunk: Buffer, _enc, cb) {
      chunks.push(Buffer.from(chunk))
      if (opts.delayMs) setTimeout(cb, opts.delayMs)
      else cb()
    },
  })
}

const OPTS = { total: 0, url: 'https://example.test/file' }

afterEach(() => vi.unstubAllGlobals())

describe('download response URL policy', () => {
  it('refuses a followed redirect that finishes on HTTP before writing bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      url: 'http://mirror.test/tool.exe',
      ok: true,
      status: 200,
      statusText: 'OK',
      body: bodyOf(new Uint8Array([1, 2, 3])),
      headers: new Headers(),
    } as Response)))

    await expect(downloadWithProgress({
      url: 'https://example.test/tool.exe',
      destPath: 'unused-after-policy-failure',
    })).rejects.toThrow('refusing non-https binary download response URL')
  })
})

describe('pumpToFile', () => {
  it('writes every byte and reports cumulative progress', async () => {
    const received: Buffer[] = []
    const progress: Array<[number, number]> = []
    const body = bodyOf(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]))

    await pumpToFile(body, collector(received), {
      ...OPTS,
      total: 5,
      onProgress: (got, total) => progress.push([got, total]),
    })

    expect(Buffer.concat(received)).toEqual(Buffer.from([1, 2, 3, 4, 5]))
    expect(progress).toEqual([
      [3, 5],
      [5, 5],
    ])
  })

  it('rejects (and does not hang) when the writable errors mid-stream', async () => {
    // The bug this replaced: a write error while parked on a drain await hung
    // forever. Erroring on the second chunk exercises the mid-stream path; the
    // vitest timeout is the backstop that proves "rejects" means "does not hang".
    let writes = 0
    const out = new Writable({
      highWaterMark: 1,
      write(_chunk, _enc, cb) {
        writes += 1
        if (writes >= 2) cb(new Error('disk full'))
        else cb()
      },
    })
    const body = bodyOf(new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]))

    await expect(pumpToFile(body, out, OPTS)).rejects.toThrow('disk full')
    // Prove the error really came from a mid-stream write, not the first one.
    expect(writes).toBeGreaterThanOrEqual(2)
  })

  it('rejects when the writable errors on the very first chunk', async () => {
    const out = new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error('immediate fail'))
      },
    })

    await expect(pumpToFile(bodyOf(new Uint8Array([1])), out, OPTS)).rejects.toThrow('immediate fail')
  })

  it('rejects when the source stream errors', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.error(new Error('connection reset'))
      },
    })

    await expect(pumpToFile(body, collector([]), OPTS)).rejects.toThrow('connection reset')
  })

  it('respects backpressure without losing or reordering bytes', async () => {
    // A slow sink with a tiny buffer forces pipeline to pause the source
    // repeatedly; all bytes must still arrive intact and in order.
    const received: Buffer[] = []
    const out = collector(received, { delayMs: 2, highWaterMark: 1 })
    const chunks = Array.from({ length: 20 }, (_, i) => new Uint8Array([i]))

    await pumpToFile(bodyOf(...chunks), out, { ...OPTS, total: 20 })

    expect(Buffer.concat(received)).toEqual(Buffer.from(chunks.map((c) => c[0]!)))
  })

  it('aborts with an IdleTimeoutError when the transfer stalls', async () => {
    const body = stallingBodyAfter(new Uint8Array([1, 2, 3]))

    await expect(
      pumpToFile(body, collector([]), { ...OPTS, idleTimeoutMs: 30 }),
    ).rejects.toBeInstanceOf(IdleTimeoutError)
  })

  it('does not fire the idle watchdog while a slow-but-alive transfer keeps delivering', async () => {
    // Chunks arrive every 10ms against a 250ms idle window: each one re-kicks the
    // watchdog well inside the deadline, so a healthy-but-slow transfer completes.
    const received: Buffer[] = []
    const chunks = [1, 2, 3, 4].map((n) => new Uint8Array([n]))

    await pumpToFile(dripBody(chunks, 10), collector(received), { ...OPTS, idleTimeoutMs: 250 })

    expect(Buffer.concat(received)).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('rejects with an AbortError (and does not hang) when the caller aborts mid-stream', async () => {
    const ac = new AbortController()
    const body = stallingBodyAfter(new Uint8Array([1]))
    setTimeout(() => ac.abort(), 20)

    // idleTimeoutMs is omitted here, so an abort is the ONLY thing that can reject:
    // assert the rejection is the abort, not some other failure.
    await expect(
      pumpToFile(body, collector([]), { ...OPTS, signal: ac.signal }),
    ).rejects.toHaveProperty('name', 'AbortError')
  })

  it('completes an empty body cleanly without reporting progress', async () => {
    const received: Buffer[] = []
    let progressCalls = 0

    await pumpToFile(bodyOf(), collector(received), { ...OPTS, onProgress: () => progressCalls++ })

    expect(received).toEqual([])
    expect(progressCalls).toBe(0)
  })
})
