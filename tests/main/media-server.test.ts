import { get as httpGet } from 'node:http'
import { once } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { until } from '../helpers/until'

// The real loopback server, driven over real HTTP — the point of this module is
// what Chromium's media stack receives, so nothing about the request path is
// substituted. Library location and logging are stubbed; targeted filesystem
// gates exercise disconnects during metadata and streaming.
// `unreadable` names paths whose read fails after the file stats fine — a disk
// going bad mid-playback, which no fixture can stage honestly.
const mocks = vi.hoisted(() => ({
  libraryDir: '',
  server: null as import('node:http').Server | null,
  statGate: null as (() => Promise<void>) | null,
  streams: [] as import('node:stream').Readable[],
  holdStream: false,
  unreadable: new Set<string>(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@main/store/config', () => ({ getLibraryDir: () => mocks.libraryDir }))
vi.mock('@main/io/logger', () => ({ log: mocks.log }))
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>()
  return { ...actual, createServer: (...args: Parameters<typeof actual.createServer>) => {
    mocks.server = actual.createServer(...args)
    return mocks.server
  } }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: async (...args: Parameters<typeof actual.stat>) => {
    const info = await actual.stat(...args)
    await mocks.statGate?.()
    return info
  } }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { Readable } = await import('node:stream')
  return {
    ...actual,
    createReadStream: (path: string, options?: unknown) => {
      const stream = mocks.holdStream ? new Readable({ read() {} })
        : mocks.unreadable.has(String(path)) ? new Readable({ read() { this.destroy(new Error('EIO: i/o error')) } })
        : actual.createReadStream(path, options as Parameters<typeof actual.createReadStream>[1])
      mocks.streams.push(stream)
      return stream
    },
  }
})

const { getMediaBaseUrl, startMediaServer, stopMediaServer } = await import('@main/media-server')

// 'abcdefghij' — ten bytes, so ranges are easy to state exactly.
const BODY = 'abcdefghij'

let base: string
// Every file sits in one tape's folder; a request names the tape and the file.
const TAPE = 'Tape000001'

beforeAll(async () => {
  mocks.libraryDir = await mkdtemp(join(tmpdir(), 'tapebox-media-server-'))
  await mkdir(join(mocks.libraryDir, TAPE))
  await writeFile(join(mocks.libraryDir, TAPE, 'tape.mp4'), BODY, 'utf8')
  await writeFile(join(mocks.libraryDir, TAPE, 'poster.jpg'), BODY, 'utf8')
  await writeFile(join(mocks.libraryDir, TAPE, 'notes.txt'), BODY, 'utf8')
  await writeFile(join(mocks.libraryDir, TAPE, 'audio.wav'), BODY, 'utf8')
  await writeFile(join(mocks.libraryDir, TAPE, 'audio.flac'), BODY, 'utf8')
  await writeFile(join(mocks.libraryDir, TAPE, 'active.html'), '<script>1</script>', 'utf8')
  await writeFile(join(mocks.libraryDir, TAPE, 'empty.mp4'), '', 'utf8')
  await mkdir(join(mocks.libraryDir, TAPE, 'folder.mp4'), { recursive: true })
})

afterEach(() => {
  mocks.unreadable.clear()
  mocks.statGate = null
  mocks.holdStream = false
  mocks.streams.length = 0
  vi.clearAllMocks()
})

afterAll(async () => {
  await stopMediaServer()
  await rm(mocks.libraryDir, { recursive: true, force: true })
})

function get(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}/${TAPE}/${path}`, init)
}

describe('the media server lifecycle', () => {
  it('has no URL to give before it is started', () => {
    expect(() => getMediaBaseUrl()).toThrow(/not started/)
  })

  it('listens on loopback behind a per-process token, and starting again keeps the one server', async () => {
    await startMediaServer()
    base = getMediaBaseUrl()
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{24}$/)

    await startMediaServer()
    expect(getMediaBaseUrl(), 'the second start is a no-op').toBe(base)
  })
})

describe('serving a library file', () => {
  it('does not open a stream after the client disconnects during metadata lookup', async () => {
    let release!: () => void
    let entered!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    mocks.statGate = async () => { entered(); await pending }
    const connection = once(mocks.server!, 'connection')
    const client = httpGet(`${base}/${TAPE}/tape.mp4`)
    client.on('error', () => {})
    const [socket] = await connection
    await started
    const closed = once(socket, 'close')
    client.destroy()
    await closed
    release()
    await nextTurn()
    expect(mocks.streams).toHaveLength(0)
  })

  it('destroys an opened file stream when the client disconnects', async () => {
    mocks.holdStream = true
    const connection = once(mocks.server!, 'connection')
    const client = httpGet(`${base}/${TAPE}/tape.mp4`)
    client.on('error', () => {})
    const [socket] = await connection
    await until(() => expect(mocks.streams).toHaveLength(1))
    const stream = mocks.streams[0]!
    const closed = once(stream, 'close')
    client.destroy()
    await closed
    expect(stream.destroyed).toBe(true)
    socket.destroy()
  })

  it.each([['audio.wav', 'audio/wav'], ['audio.flac', 'audio/flac']])('serves supported passive audio %s', async (path, type) => {
    const response = await get(path!)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(type)
    expect(await response.text()).toBe(BODY)
  })

  it('continues to refuse active content', async () => {
    expect((await get('active.html')).status).toBe(404)
  })

  it.each(['tape.mp4', 'tape.mp4?collection=3'])('serves %s with its media type', async (path) => {
    const response = await get(path)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-length')).toBe('10')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-range')).toBeNull()
    expect(await response.text()).toBe(BODY)
  })

  it('serves a poster as JPEG', async () => {
    const response = await get('poster.jpg')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
  })

  it('answers a HEAD from the file facts alone, without opening it', async () => {
    // Marked unreadable: if the handler opened the file for a HEAD, the read
    // error would be logged even though Node discards the body either way.
    mocks.unreadable.add(join(mocks.libraryDir, TAPE, 'tape.mp4'))

    const response = await get('tape.mp4', { method: 'HEAD' })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('10')
    expect(await response.text()).toBe('')
    expect(mocks.log.error).not.toHaveBeenCalled()
    mocks.unreadable.clear()
  })

  it('serves an empty file as an empty 200', async () => {
    const response = await get('empty.mp4')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('0')
    expect(await response.text()).toBe('')
  })

  it('finds a file whose name needed encoding', async () => {
    await writeFile(join(mocks.libraryDir, TAPE, 'holiday #2 (best).mp4'), BODY, 'utf8')

    const response = await get(encodeURIComponent('holiday #2 (best).mp4'))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(BODY)
  })
})

describe('seeking', () => {
  it('sends the asked-for slice as a 206 that states its place in the file', async () => {
    const response = await get('tape.mp4', { headers: { Range: 'bytes=2-5' } })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(response.headers.get('content-length')).toBe('4')
    expect(await response.text()).toBe('cdef')
  })

  it('runs an open-ended range to the end of the file', async () => {
    const response = await get('tape.mp4', { headers: { Range: 'bytes=7-' } })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 7-9/10')
    expect(await response.text()).toBe('hij')
  })

  it('reads a suffix range from the tail', async () => {
    const response = await get('tape.mp4', { headers: { Range: 'bytes=-3' } })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 7-9/10')
    expect(await response.text()).toBe('hij')
  })

  it('clamps a range that overruns the end', async () => {
    const response = await get('tape.mp4', { headers: { Range: 'bytes=8-99' } })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 8-9/10')
    expect(await response.text()).toBe('ij')
  })

  it.each([
    ['a range starting past the end', 'bytes=10-12'],
    ['a backwards range', 'bytes=6-2'],
    ['a zero-length suffix', 'bytes=-0'],
  ])('refuses %s and says how long the file is', async (_case, range) => {
    const response = await get('tape.mp4', { headers: { Range: range } })

    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
  })

  it.each([
    ['a header it cannot parse', 'pages=1-2'],
    ['an empty range', 'bytes=-'],
  ])('falls back to the whole file for %s', async (_case, range) => {
    const response = await get('tape.mp4', { headers: { Range: range } })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(BODY)
  })
})

describe('what the server refuses', () => {
  it('turns away another local process that does not have the token', async () => {
    const response = await fetch(`${base.replace(/\/[\w-]{24}$/, '/not-the-token')}/${TAPE}/tape.mp4`)

    expect(response.status).toBe(403)
  })

  it.each([
    ['a traversal out of the library', '..%2F..%2Fetc%2Fpasswd'],
    ['a backslash path', 'sub%5Ctape.mp4'],
    ['a null byte', 'tape.mp4%00.txt'],
    ['an empty name', ''],
  ])('refuses %s', async (_case, name) => {
    const response = await get(name)

    expect(response.status).toBe(403)
  })

  it.each([
    ['a file type the library never holds', 'notes.txt', 404],
    ['a file that is not there', 'missing.mp4', 404],
    ['a directory named like a tape', 'folder.mp4', 404],
  ])('answers 404 for %s', async (_case, name, status) => {
    expect((await get(name)).status).toBe(status)
  })

  it('answers 500 for a URL it cannot decode', async () => {
    const response = await get('%E0%A4%A')

    expect(response.status).toBe(500)
    expect(mocks.log.error).toHaveBeenCalledWith('media-server: request failed', expect.anything())
  })

  it('tears the response down and logs when the file cannot be read', async () => {
    mocks.unreadable.add(join(mocks.libraryDir, TAPE, 'tape.mp4'))

    await expect(get('tape.mp4').then((response) => response.text())).rejects.toThrow()
    expect(mocks.log.error).toHaveBeenCalledWith(
      'media-server: read error',
      expect.objectContaining({ filename: 'tape.mp4' }),
    )

    mocks.unreadable.clear()
    expect((await get('tape.mp4')).status, 'the server keeps serving afterwards').toBe(200)
  })

  it('answers 404 for a URL shaped unlike <token>/<tape>/<file>', async () => {
    expect((await get('nested/tape.mp4')).status).toBe(404)
    expect((await fetch(`${base}/tape.mp4`)).status).toBe(404)
  })

  it.each(['not-an-id', 'Tape00000%2F'])('refuses a tape segment that is not a tape id: %s', async (tape) => {
    expect((await fetch(`${base}/${tape}/tape.mp4`)).status).toBe(403)
  })

  it('allows only reads', async () => {
    const response = await get('tape.mp4', { method: 'POST' })

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
  })
})

describe('stopping', () => {
  it('closes the port and has no URL to give again', async () => {
    const stopped = base

    await stopMediaServer()

    expect(() => getMediaBaseUrl()).toThrow(/not started/)
    await expect(fetch(`${stopped}/tape.mp4`)).rejects.toThrow()
    await expect(stopMediaServer(), 'stopping again is a no-op').resolves.toBeUndefined()
  })
})
