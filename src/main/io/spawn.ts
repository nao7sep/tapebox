import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { LoggableError } from '@shared/error'

/**
 * Thin wrappers around node:child_process.spawn.
 *
 * Why not execa: execa pre-v6 is CJS and has no AbortSignal support;
 * execa v6+ is ESM-only and pulls in a dozen deps for features we don't
 * need. node:child_process.spawn is the right size for our use case —
 * it has native AbortSignal support since Node 16 and works identically
 * on macOS/Windows/Linux.
 *
 * Two shapes:
 *   - execCapture(): one-shot, buffers full stdout/stderr, throws on
 *     non-zero exit unless { reject: false }. Used for probe, version
 *     checks, and quick ffmpeg jobs.
 *   - spawnStreaming(): hands back the raw ChildProcess so the caller can
 *     attach 'data' listeners for live progress / per-line parsing. Used
 *     for downloads and page scan.
 *
 * Both honour:
 *   - signal: AbortSignal (terminates the owned process tree on Windows)
 *   - idleTimeoutMs: kill the process if no stdout/stderr arrived for this
 *     many ms. Resets on each chunk. This is the right kind of timeout for
 *     network-bound work — a wall-clock timeout would falsely kill
 *     legitimately slow downloads, but a stuck process is silent.
 */

export type SpawnOptions = {
  env?: NodeJS.ProcessEnv
  cwd?: string
  signal?: AbortSignal
  /** Kill the child if no output arrives for this many ms. */
  idleTimeoutMs?: number
}

export type CaptureResult = {
  stdout: string
  stderr: string
  exitCode: number | null
}

export type CaptureOptions = SpawnOptions & {
  /** If true, resolve with non-zero exit codes instead of throwing. */
  reject?: boolean
}

export class SubprocessError extends Error implements LoggableError {
  constructor(
    public readonly command: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(`${command} exited with code ${exitCode}: ${stderr.slice(0, 500)}`)
    this.name = 'SubprocessError'
  }

  // Discrete, machine-parseable fields for describeError — exitCode as a number
  // to filter on, and the FULL stderr (the message truncates it to 500 chars).
  toLogFields(): Record<string, unknown> {
    return { command: this.command, exitCode: this.exitCode, stderr: this.stderr }
  }
}

export class IdleTimeoutError extends Error implements LoggableError {
  constructor(public readonly command: string, public readonly idleMs: number) {
    super(`${command} idle for ${idleMs}ms`)
    this.name = 'IdleTimeoutError'
  }

  toLogFields(): Record<string, unknown> {
    return { command: this.command, idleMs: this.idleMs }
  }
}

type StreamingChild = ChildProcessByStdio<null, Readable, Readable> & {
  // Set by the idle watchdog when it kills the process; waitForExit/execCapture
  // surface it as the close cause instead of a generic non-zero exit.
  idleError?: IdleTimeoutError | null
  abortError?: Error | null
}

/** Terminate the process we started and, on Windows, every descendant it owns.
 * yt-dlp starts ffmpeg and Deno; killing only yt-dlp lets those children keep
 * mutating files after Cancel has returned. `taskkill /T` is Windows' native
 * process-tree operation and needs no shell. */
function terminateOwnedProcessTree(child: StreamingChild): void {
  const pid = child.pid
  if (process.platform === 'win32' && pid !== undefined) {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    const fallback = () => {
      child.kill('SIGTERM')
    }
    killer.once('error', fallback)
    killer.once('close', (code) => {
      if (code !== 0) fallback()
    })
    return
  }
  child.kill('SIGTERM')
}

function bindAbort(child: StreamingChild, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {}
  const onAbort = () => {
    child.abortError = signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError')
    terminateOwnedProcessTree(child)
  }
  if (signal.aborted) {
    onAbort()
    return () => {}
  }
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

function startIdleWatch(
  child: StreamingChild,
  idleMs: number | undefined,
  onTimeout: () => void,
): { kick: () => void; stop: () => void } {
  if (idleMs == null) return { kick: () => {}, stop: () => {} }
  let timer: NodeJS.Timeout | null = null
  const kick = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      terminateOwnedProcessTree(child)
      onTimeout()
    }, idleMs)
  }
  const stop = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  kick()
  return { kick, stop }
}

export async function execCapture(
  command: string,
  args: readonly string[],
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  opts.signal?.throwIfAborted()
  const child = spawn(command, args as string[], {
    env: opts.env,
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as StreamingChild

  let stdout = ''
  let stderr = ''
  let idleError: IdleTimeoutError | null = null

  const idle = startIdleWatch(child, opts.idleTimeoutMs, () => {
    idleError = new IdleTimeoutError(command, opts.idleTimeoutMs!)
  })
  const unbindAbort = bindAbort(child, opts.signal)

  child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); idle.kick() })
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); idle.kick() })

  return new Promise<CaptureResult>((resolve, reject) => {
    child.on('error', (err) => {
      idle.stop()
      unbindAbort()
      reject(child.abortError ?? err)
    })
    child.on('close', (code) => {
      idle.stop()
      unbindAbort()
      if (child.abortError) return reject(child.abortError)
      if (idleError) return reject(idleError)
      const result: CaptureResult = { stdout, stderr, exitCode: code }
      if (code === 0 || opts.reject === false) resolve(result)
      else reject(new SubprocessError(command, code, stderr))
    })
  })
}

/**
 * Streaming spawn. Caller attaches listeners to child.stdout/stderr and
 * awaits waitForExit(child). Idle timeout, if any, is applied automatically;
 * the caller's data handler is invoked first so per-line parsing remains
 * responsive.
 */
export function spawnStreaming(
  command: string,
  args: readonly string[],
  opts: SpawnOptions = {},
): StreamingChild {
  opts.signal?.throwIfAborted()
  const child = spawn(command, args as string[], {
    env: opts.env,
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as StreamingChild

  if (opts.idleTimeoutMs != null) {
    const idle = startIdleWatch(child, opts.idleTimeoutMs, () => {
      // Record the cause on the child; waitForExit consults it on close. We do NOT
      // replay it as an 'error' event on the already-killed child — that depended on
      // listener ordering against a dead process.
      child.idleError = new IdleTimeoutError(command, opts.idleTimeoutMs!)
    })
    child.stdout.on('data', () => idle.kick())
    child.stderr.on('data', () => idle.kick())
    child.on('close', () => idle.stop())
    child.on('error', () => idle.stop())
  }

  const unbindAbort = bindAbort(child, opts.signal)
  child.on('close', unbindAbort)
  child.on('error', unbindAbort)

  return child
}

export function waitForExit(
  child: StreamingChild,
  opts: { reject?: boolean; command?: string } = {},
): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      // An idle timeout killed the process — surface that as the cause rather than a
      // generic non-zero exit.
      if (child.idleError) return reject(child.idleError)
      if (child.abortError) return reject(child.abortError)
      if (code === 0 || opts.reject === false) resolve(code)
      else reject(new SubprocessError(opts.command ?? 'process', code, ''))
    })
  })
}

/**
 * Cross-chunk line buffer. yt-dlp prints progress and the final-filepath
 * marker as discrete lines, but 'data' events can carry partial lines when
 * a chunk boundary lands mid-line. The bug that caused 'yt-dlp did not
 * report a final file path' on successful downloads — fix at the source.
 *
 * Usage:
 *   const lb = makeLineBuffer((line) => parse(line))
 *   child.stdout.on('data', lb.feed)
 *   child.stderr.on('data', lb.feed)
 *   await waitForExit(child)
 *   lb.flush()  // emit any trailing line without a newline
 *
 * `splitOnCR` also breaks on carriage returns, so a tool that redraws a status
 * line in place (ffmpeg's `frame=… time=… speed=…`) surfaces each redraw as its
 * own line instead of one ever-growing buffer. Off by default — yt-dlp's
 * `--newline` output is plain `\n`.
 */
export function makeLineBuffer(
  onLine: (line: string) => void,
  opts: { splitOnCR?: boolean } = {},
): {
  feed: (chunk: Buffer | string) => void
  flush: () => void
} {
  const breaks = opts.splitOnCR ? /\r\n|\r|\n/ : /\n/
  let buf = ''
  return {
    feed(chunk) {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const parts = buf.split(breaks)
      // The last part is the (possibly partial) remainder — keep it buffered.
      buf = parts.pop() ?? ''
      for (const p of parts) onLine(p.replace(/\r$/, ''))
    },
    flush() {
      if (buf.length > 0) {
        onLine(buf.replace(/\r$/, ''))
        buf = ''
      }
    },
  }
}
