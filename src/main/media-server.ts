import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { nanoid } from 'nanoid'
import { getSettings } from '@main/store/config'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'

/**
 * Loopback HTTP server that streams library files to the renderer's
 * <video>/<audio> elements.
 *
 * Why an HTTP server instead of a custom protocol: Chromium's media pipeline
 * uses a far more capable data source for HTTP than for custom schemes — it
 * does range-based buffering, overlapping partial requests, and fast seeks.
 * A custom protocol.handle scheme goes through a thinner loader that, even
 * with byte-perfect range responses, never reaches a "playing, seekable"
 * state. So we serve over the standard door the media element was built for.
 *
 * Security model (no auth server, no exotic crypto):
 *   - bound to 127.0.0.1 only, so it is never reachable off-machine;
 *   - every URL carries a random per-process token as its first path segment,
 *     so other local processes can't browse the library through the open port;
 *   - filenames are restricted to flat basenames inside libraryDir with a
 *     known media extension — no traversal, no arbitrary files.
 *
 * URL shape: http://127.0.0.1:<port>/<token>/<encodeURIComponent(filename)>
 */

const TOKEN_LENGTH = 24

/**
 * Extension → MIME type. This map doubles as the allowlist: a file whose
 * extension is absent here is simply not served (404).
 */
const MIME_TYPES: Record<string, string> = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
}

let server: Server | null = null
let token: string | null = null
let port: number | null = null

/**
 * Start the server once. Resolves after it is listening, so callers can read
 * getMediaBaseUrl() immediately afterward. Idempotent: a second call is a
 * no-op while the server is up.
 */
export function startMediaServer(): Promise<void> {
  if (server) return Promise.resolve()
  token = nanoid(TOKEN_LENGTH)
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => void handleRequest(req, res))
    s.once('error', (err) => {
      log.error('media-server: failed to start', { error: describeError(err) })
      reject(err)
    })
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      port = addr && typeof addr === 'object' ? addr.port : null
      server = s
      log.info('media-server: listening', { port })
      resolve()
    })
  })
}

export async function stopMediaServer(): Promise<void> {
  const s = server
  if (!s) return
  server = null
  token = null
  port = null
  // The <video> element keeps a connection alive; without destroying it,
  // server.close() waits on it forever and hangs app quit. Destroy open
  // connections first so close() resolves immediately.
  s.closeAllConnections()
  await new Promise<void>((resolve) => s.close(() => resolve()))
}

/** Base URL the renderer appends '/<encoded filename>' to. Throws if not started. */
export function getMediaBaseUrl(): string {
  if (!server || port === null || !token) {
    throw new Error('media-server: not started')
  }
  return `http://127.0.0.1:${port}/${token}`
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end()
      return
    }

    // pathname is /<token>/<encodedFilename> — exactly three segments once split
    // on '/', the first being the empty string before the leading slash.
    const pathname = new URL(req.url ?? '', 'http://127.0.0.1').pathname
    const segments = pathname.split('/')
    if (segments.length !== 3) {
      res.writeHead(404)
      res.end()
      return
    }
    const [, requestToken, encodedName] = segments
    if (!token || requestToken !== token) {
      res.writeHead(403)
      res.end()
      return
    }

    const filename = decodeURIComponent(encodedName)
    const full = resolveLibraryFile(filename)
    if (!full) {
      res.writeHead(403)
      res.end()
      return
    }

    const contentType = MIME_TYPES[extname(filename).toLowerCase()]
    if (!contentType) {
      res.writeHead(404)
      res.end()
      return
    }

    let size: number
    try {
      const info = await stat(full)
      if (!info.isFile()) {
        res.writeHead(404)
        res.end()
        return
      }
      size = info.size
    } catch {
      res.writeHead(404)
      res.end()
      return
    }

    const range = parseRange(req.headers.range, size)
    if (range.kind === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' })
      res.end()
      return
    }

    const start = range.kind === 'partial' ? range.start : 0
    const end = range.kind === 'partial' ? range.end : Math.max(0, size - 1)
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(size === 0 ? 0 : end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    }
    if (range.kind === 'partial') {
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    }
    res.writeHead(range.kind === 'partial' ? 206 : 200, headers)

    if (req.method === 'HEAD' || size === 0) {
      res.end()
      return
    }

    // Stream the requested slice. On a genuine read error, tear down the
    // response. On client abort — which happens on every seek and on element
    // teardown (releaseMedia) — destroy the file stream so we don't leak the
    // handle. Our own stream.destroy() emits 'close', not 'error', so the
    // error handler only fires for real I/O failures.
    const stream = createReadStream(full, { start, end })
    stream.on('error', (err) => {
      log.error('media-server: read error', { filename, error: describeError(err) })
      res.destroy()
    })
    req.on('close', () => stream.destroy())
    stream.pipe(res)
  } catch (err) {
    log.error('media-server: request failed', { error: describeError(err) })
    if (!res.headersSent) res.writeHead(500)
    res.end()
  }
}

/**
 * Resolve a requested filename to an absolute path inside libraryDir, or null
 * if it escapes. Library files are flat basenames, so any path separator is an
 * immediate reject; the containment check is belt-and-suspenders. libraryDir is
 * read per request so a changed setting is honored without a restart.
 */
function resolveLibraryFile(filename: string): string | null {
  if (!filename) return null
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')) return null
  const libDir = normalize(getSettings().libraryDir)
  const full = normalize(join(libDir, filename))
  const within = full === libDir || full.startsWith(libDir + sep)
  return within ? full : null
}

type RangeResult =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' }

/**
 * Parse a single HTTP Range header against a known size. <video> only ever
 * sends one range, so multi-range is not supported; a malformed or absent
 * header serves the whole file (the lenient, spec-permitted behavior).
 */
function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'full' }
  const match = /^bytes=(\d*)-(\d*)/.exec(header.trim())
  if (!match) return { kind: 'full' }
  const [, startStr, endStr] = match
  if (startStr === '' && endStr === '') return { kind: 'full' }

  let start: number
  let end: number
  if (startStr === '') {
    // suffix form: bytes=-N → the last N bytes
    const n = Number(endStr)
    if (n <= 0) return { kind: 'unsatisfiable' }
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(startStr)
    end = endStr === '' ? size - 1 : Number(endStr)
  }

  if (start > end || start >= size) return { kind: 'unsatisfiable' }
  if (end >= size) end = size - 1
  return { kind: 'partial', start, end }
}
