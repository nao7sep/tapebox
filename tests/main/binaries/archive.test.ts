import fs, { type ReadStream, type WriteStream } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib, { crc32, deflateRawSync, type InflateRaw } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractFileFromZip } from '@main/binaries/archive'
import { writeFileAtomicVia } from '@main/io/atomic-file'
import { until } from '../../helpers/until'

vi.mock('@main/io/logger', () => ({ log: { warn: vi.fn() } }))

// Use the real ZIP decoder and filesystem. These spies only expose the actual
// streams and hold selected reads/physical closes to exercise ownership races.
const gracefulFs = createRequire(import.meta.url)('graceful-fs') as typeof fs
const realRead = fs.createReadStream.bind(fs)
const realWrite = fs.createWriteStream.bind(fs)
const realInflate = zlib.createInflateRaw.bind(zlib)

type ZipEntry = {
  path: string
  data?: Buffer
  method?: number
  flags?: number
  advertisedSize?: number
  offset?: number
  zip64?: boolean
  descriptor?: boolean
}

/** Generate small, valid local/central records, including ZIP64 size extras. */
function zipBytes(entries: ZipEntry[], zip64Directory = false): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path)
    const data = entry.data ?? Buffer.alloc(0)
    const method = entry.method ?? 8
    const compressed = method === 8 ? deflateRawSync(data) : data
    const flags = (entry.flags ?? 0) | (entry.descriptor ? 8 : 0)
    const advertised = entry.advertisedSize ?? data.length
    const localExtra = Buffer.alloc(entry.zip64 ? 20 : 0)
    if (entry.zip64) {
      localExtra.writeUInt16LE(1, 0)
      localExtra.writeUInt16LE(16, 2)
      localExtra.writeBigUInt64LE(BigInt(advertised), 4)
      localExtra.writeBigUInt64LE(BigInt(compressed.length), 12)
    }
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(entry.zip64 ? 45 : 20, 4)
    localHeader.writeUInt16LE(flags, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt32LE(crc32(data), 14)
    if (entry.zip64 || !entry.descriptor) {
      localHeader.writeUInt32LE(entry.zip64 ? 0xffffffff : compressed.length, 18)
      localHeader.writeUInt32LE(entry.zip64 ? 0xffffffff : advertised, 22)
    }
    localHeader.writeUInt16LE(name.length, 26)
    localHeader.writeUInt16LE(localExtra.length, 28)
    const descriptor = Buffer.alloc(entry.descriptor ? (entry.zip64 ? 24 : 16) : 0)
    if (entry.descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(crc32(data), 4)
      if (entry.zip64) {
        descriptor.writeBigUInt64LE(BigInt(compressed.length), 8)
        descriptor.writeBigUInt64LE(BigInt(advertised), 16)
      } else {
        descriptor.writeUInt32LE(compressed.length, 8)
        descriptor.writeUInt32LE(advertised, 12)
      }
    }
    local.push(localHeader, name, localExtra, compressed, descriptor)

    const extra = Buffer.alloc(entry.zip64 ? 28 : 0)
    if (entry.zip64) {
      extra.writeUInt16LE(1, 0)
      extra.writeUInt16LE(24, 2)
      extra.writeBigUInt64LE(BigInt(advertised), 4)
      extra.writeBigUInt64LE(BigInt(compressed.length), 12)
      extra.writeBigUInt64LE(BigInt(entry.offset ?? offset), 20)
    }
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(entry.zip64 ? 45 : 20, 6)
    header.writeUInt16LE(flags, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt32LE(crc32(data), 16)
    header.writeUInt32LE(entry.zip64 ? 0xffffffff : compressed.length, 20)
    header.writeUInt32LE(entry.zip64 ? 0xffffffff : advertised, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt16LE(extra.length, 30)
    header.writeUInt32LE(entry.zip64 ? 0xffffffff : entry.offset ?? offset, 42)
    central.push(header, name, extra)
    offset += localHeader.length + name.length + localExtra.length + compressed.length + descriptor.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  if (zip64Directory) {
    const record = Buffer.alloc(56)
    record.writeUInt32LE(0x06064b50, 0)
    record.writeBigUInt64LE(44n, 4)
    record.writeUInt16LE(45, 12)
    record.writeUInt16LE(45, 14)
    record.writeBigUInt64LE(BigInt(entries.length), 24)
    record.writeBigUInt64LE(BigInt(entries.length), 32)
    record.writeBigUInt64LE(BigInt(directory.length), 40)
    record.writeBigUInt64LE(BigInt(offset), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8)
    locator.writeUInt32LE(1, 16)
    end.writeUInt16LE(0xffff, 8)
    end.writeUInt16LE(0xffff, 10)
    end.writeUInt32LE(0xffffffff, 16)
    return Buffer.concat([...local, directory, record, locator, end])
  }
  return Buffer.concat([...local, directory, end])
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

let dir: string
let readers: ReadStream[]
let writers: WriteStream[]
let inflaters: InflateRaw[]
let adjustRead: ((stream: ReadStream, index: number, start: number, end?: number) => void) | undefined
let releaseClose: (() => void) | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-archive-'))
  readers = []
  writers = []
  inflaters = []
  adjustRead = undefined
  releaseClose = undefined
  const trackedRead: typeof fs.createReadStream = (path, options) => {
    const opts = typeof options === 'object' ? options : { encoding: options }
    const stream = realRead(path, { ...opts, highWaterMark: 64 })
    // Also absorb injected errors in the old adapter, whose central-directory
    // and payload readers lacked propagation. Settlement must still reject.
    stream.on('error', () => {})
    const index = readers.length
    readers.push(stream)
    adjustRead?.(stream, index, opts?.start ?? 0, opts?.end)
    return stream
  }
  vi.spyOn(fs, 'createReadStream').mockImplementation(trackedRead)
  vi.spyOn(gracefulFs, 'createReadStream').mockImplementation(trackedRead)
  vi.spyOn(fs, 'createWriteStream').mockImplementation((path, options) => {
    const stream = realWrite(path, options)
    writers.push(stream)
    return stream
  })
  vi.spyOn(zlib, 'createInflateRaw').mockImplementation((options) => {
    const stream = realInflate(options)
    inflaters.push(stream)
    return stream
  })
  syncBuiltinESMExports()
})

afterEach(async () => {
  releaseClose?.()
  await Promise.all([...readers, ...writers, ...inflaters].map(async (stream) => {
    if (stream.closed) return
    const closed = new Promise<void>((done) => stream.once('close', done))
    stream.destroy()
    await closed
  }))
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  await rm(dir, { recursive: true, force: true })
})

async function archive(...entries: ZipEntry[]): Promise<string> {
  const path = join(dir, 'archive.zip')
  await writeFile(path, zipBytes(entries))
  return path
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

function expectClosed(): void {
  expect(readers.length).toBeGreaterThan(0)
  expect(readers.every((reader) => reader.closed)).toBe(true)
  expect(writers.every((writer) => writer.closed)).toBe(true)
  expect(inflaters.every((inflater) => inflater.closed)).toBe(true)
}

// Identify the old adapter's combined local-header/payload read and the new
// adapter's payload range. The separate fixed-size local-header read is allowed.
function isPayload(index: number, start: number, end?: number): boolean {
  return index >= 2 && !(start === 0 && end === 29)
}

function holdPhysicalClose(stream: ReadStream) {
  const started = deferred()
  const allowed = deferred()
  const destroy = stream._destroy.bind(stream)
  stream._destroy = (err, callback) => {
    started.resolve()
    void allowed.promise.then(() => destroy(err, callback))
  }
  releaseClose = allowed.resolve
  return started
}

describe('extractFileFromZip', () => {
  it.each([0, 8])('extracts a real ZIP entry with compression method %s and closes every stream', async (method) => {
    const zip = await archive({ path: 'deno', data: Buffer.from([1, 2, 3]), method })
    const out = join(dir, 'deno')
    await extractFileFromZip(zip, 'deno', out, 1024)
    expect([...(await readFile(out))]).toEqual([1, 2, 3])
    expectClosed()
  })

  it('matches a nested entry by basename', async () => {
    const zip = await archive({ path: 'ffmpeg-7.1/readme.txt' }, { path: 'ffmpeg-7.1/bin/ffmpeg', data: Buffer.from([9, 9]) })
    const out = join(dir, 'ffmpeg')
    await extractFileFromZip(zip, 'ffmpeg', out, 1024)
    expect([...(await readFile(out))]).toEqual([9, 9])
  })

  it('prefers an exact path match over a basename match', async () => {
    const zip = await archive({ path: 'nested/ffmpeg', data: Buffer.from([1]) }, { path: 'ffmpeg', data: Buffer.from([2, 2]) })
    const out = join(dir, 'ffmpeg')
    await extractFileFromZip(zip, 'ffmpeg', out, 1024)
    expect([...(await readFile(out))]).toEqual([2, 2])
  })

  it('rejects ambiguous basenames without writing', async () => {
    const zip = await archive({ path: 'x/ffmpeg' }, { path: 'y/ffmpeg' })
    const out = join(dir, 'ffmpeg')
    await expect(extractFileFromZip(zip, 'ffmpeg', out, 1024)).rejects.toThrow('File ffmpeg matches multiple entries in archive: x/ffmpeg, y/ffmpeg')
    expect(await exists(out)).toBe(false)
    expectClosed()
  })

  it('ignores directory entries and names available files on a missing match', async () => {
    const zip = await archive({ path: 'bin/ffmpeg/' }, { path: 'readme.txt' }, { path: 'LICENSE' })
    const out = join(dir, 'ffmpeg')
    await expect(extractFileFromZip(zip, 'ffmpeg', out, 1024)).rejects.toThrow('File ffmpeg not found in archive. Available: readme.txt, LICENSE')
    expect(await exists(out)).toBe(false)
  })

  it('uses central sizes for a deflated entry with a data descriptor and ZIP64 extras', async () => {
    const zip = await archive({ path: 'deno', data: Buffer.from('executable'), descriptor: true, zip64: true })
    const out = join(dir, 'deno')
    await extractFileFromZip(zip, 'deno', out, 1024)
    expect(await readFile(out, 'utf8')).toBe('executable')
    expectClosed()
  })

  it('supports ZIP64 central-directory records and a nested selected entry', async () => {
    const zip = join(dir, 'zip64.zip')
    await writeFile(zip, zipBytes([{ path: 'LICENSE' }, { path: 'bin/deno', data: Buffer.from('executable'), zip64: true, descriptor: true }], true))
    const out = join(dir, 'deno')
    await extractFileFromZip(zip, 'deno', out, 1024)
    expect(await readFile(out, 'utf8')).toBe('executable')
    expectClosed()
  })

  it('extracts an empty stored entry without reading bytes from the next header', async () => {
    const zip = await archive({ path: 'deno', method: 0 })
    const out = join(dir, 'deno')
    await extractFileFromZip(zip, 'deno', out, 10)
    expect(await readFile(out)).toHaveLength(0)
    expectClosed()
  })

  it('rejects a corrupt deflate payload and closes the source, inflater and writer', async () => {
    const zip = await archive({ path: 'deno', data: Buffer.from('executable') })
    const corrupt = await readFile(zip)
    corrupt.fill(0xff, 34, 34 + deflateRawSync(Buffer.from('executable')).length)
    await writeFile(zip, corrupt)
    await expect(extractFileFromZip(zip, 'deno', join(dir, 'deno'), 1024)).rejects.toBeInstanceOf(Error)
    expectClosed()
  })

  it('rejects a real central-directory advertised size before creating the writer', async () => {
    const zip = await archive({ path: 'deno', data: Buffer.from([1, 2, 3, 4]) })
    const out = join(dir, 'deno')
    await expect(extractFileFromZip(zip, 'deno', out, 3)).rejects.toThrow('too large')
    expect(writers).toHaveLength(0)
    expect(await exists(out)).toBe(false)
    expectClosed()
  })

  it('enforces the streamed limit when the advertised size is false', async () => {
    const zip = await archive({ path: 'deno', data: Buffer.from([1, 2, 3, 4]), advertisedSize: 1 })
    await expect(extractFileFromZip(zip, 'deno', join(dir, 'deno'), 3)).rejects.toThrow('exceeded 3 bytes')
    expectClosed()
  })

  it('rejects a decompressed length different from the central-directory size', async () => {
    const zip = await archive({ path: 'deno', data: Buffer.from([1, 2, 3]), advertisedSize: 4 })
    await expect(extractFileFromZip(zip, 'deno', join(dir, 'deno'), 10)).rejects.toThrow('size')
    expectClosed()
  })

  it.each([{ flags: 1, message: 'encrypted' }, { method: 12, message: 'compression' }, { offset: 0xfffffff0, message: 'offset' }])('rejects unsupported or invalid entry metadata: $message', async (options) => {
    const zip = await archive({ path: 'deno', data: Buffer.from([1, 2, 3]), ...options })
    await expect(extractFileFromZip(zip, 'deno', join(dir, 'deno'), 10)).rejects.toThrow(options.message)
    expect(writers).toHaveLength(0)
    expectClosed()
  })

  it.each(['abort', 'source error'])('settles %s during a parked central-directory read and closes the physical source', async (action) => {
    const zip = await archive({ path: 'deno', data: Buffer.from([1, 2, 3]) })
    const parked = deferred()
    let source!: ReadStream
    adjustRead = (stream, index) => {
      if (index !== 1) return
      source = stream
      stream._read = () => {}
      stream.once('open', parked.resolve)
    }
    const controller = new AbortController()
    let outcome: unknown
    const extraction = extractFileFromZip(zip, 'deno', join(dir, 'deno'), 10, controller.signal)
      .then(() => { outcome = 'resolved' }, (err: unknown) => { outcome = err })
    await parked.promise
    const error = new Error('injected source failure')
    if (action === 'abort') controller.abort(new DOMException('cancel extraction', 'AbortError'))
    else source.destroy(error)
    await until(() => expect(outcome).toBeDefined())
    await extraction
    if (action === 'abort') expect(outcome).toMatchObject({ name: 'AbortError' })
    else expect(outcome).toBe(error)
    expectClosed()
    expect(writers).toHaveLength(0)
  })

  it.each(['abort', 'write failure', 'source error', 'stream limit'])('waits for payload physical close on %s before releasing the atomic stage', async (action) => {
    // Incompressible enough to park before the compressed range reaches EOF.
    const data = Buffer.alloc(4096)
    for (let i = 0; i < data.length; i++) data[i] = (i * 137 + (i >>> 3)) & 255
    const zip = await archive({ path: 'deno', data, advertisedSize: action === 'stream limit' ? 1 : data.length })
    const destination = join(dir, 'installed-deno')
    const stage = join(dir, 'deno-owned.tmp')
    await writeFile(destination, 'previous executable')
    const parked = deferred()
    let source!: ReadStream
    let closeStarted!: ReturnType<typeof deferred>
    let isParked = false
    adjustRead = (stream, index, start, end) => {
      if (!isPayload(index, start, end)) return
      source = stream
      closeStarted = holdPhysicalClose(stream)
      if (action !== 'stream limit') {
        const read = stream._read.bind(stream)
        stream._read = (size) => { if (!isParked) read(size) }
        stream.once('data', () => { isParked = true; parked.resolve() })
      }
    }
    const controller = new AbortController()
    let settled = false
    const extraction = writeFileAtomicVia(destination, (path) => extractFileFromZip(zip, 'deno', action === 'write failure' ? join(dir, 'absent', 'deno') : path, action === 'stream limit' ? 3 : data.length, controller.signal), stage, controller.signal)
      .then(() => { settled = true; return 'resolved' }, (err: unknown) => { settled = true; return err })
    if (action === 'write failure' || action === 'stream limit') {
      await until(() => expect(source).toBeDefined())
    } else {
      await parked.promise
      await until(() => expect(inflaters.length).toBeGreaterThan(0))
      if (action === 'abort') controller.abort(new DOMException('cancel extraction', 'AbortError'))
      if (action === 'source error') source.destroy(new Error('injected payload failure'))
    }
    const boundary = await Promise.race([closeStarted.promise.then(() => 'closing'), extraction.then(() => 'settled')])
    expect(boundary).toBe('closing')
    await new Promise<void>((done) => setImmediate(done))
    expect(settled).toBe(false)
    expect(source.closed).toBe(false)
    expect(await exists(stage)).toBe(true)
    expect(await readFile(destination, 'utf8')).toBe('previous executable')
    releaseClose!()
    await until(() => expect(settled).toBe(true))
    const outcome = await extraction
    if (action === 'abort') expect(outcome).toMatchObject({ name: 'AbortError' })
    else expect(outcome).toBeInstanceOf(Error)
    expect(await exists(stage)).toBe(false)
    expect(await readFile(destination, 'utf8')).toBe('previous executable')
    expectClosed()
  })
})
