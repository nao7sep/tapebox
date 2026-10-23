import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { LoggableError } from '@shared/error'
import type { RunStop } from '@shared/records'
import { StopRequest } from '@main/stop-request'
import { nowUtcIso } from '@shared/utc'

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
  /** Hide a Windows console for a background-only query. */
  windowsHide?: boolean
  /** If false, resolve with non-zero exit codes instead of throwing. */
  reject?: boolean
}

export class SubprocessError extends Error implements LoggableError {
  constructor(
    public readonly command: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
    public readonly outputKey?: string,
  ) {
    super(`${command} exited with code ${exitCode}`)
    this.name = 'SubprocessError'
  }

  // Streamed runs keep a safe stderr tail here and reference their full retained
  // output by key. One-shot calls can still supply their complete stderr.
  toLogFields(): Record<string, unknown> {
    return { command: this.command, exitCode: this.exitCode, stderr: this.stderr, ...(this.outputKey ? { outputKey: this.outputKey } : {}) }
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
  /** Windows taskkill settlement; close/error handlers await it before reporting. */
  termination?: Promise<void>
}

// Stopping a tree fits inside the quit's stop step (quit.ts QUIT_BOUNDS_MS): on
// POSIX within a session end's 1 s, on Windows, where only a user's quit stops
// work, within its 4.5 s. A download needs no graceful exit — its leftovers are
// swept — so the SIGTERM grace is short.
const WINDOWS_TREE_KILL_TIMEOUT_MS = 4_000
const POSIX_TERM_GRACE_MS = 500
const POSIX_KILL_SETTLE_MS = 300

/** The longest stopping an owned tree takes to settle, per platform family. */
export const TREE_STOP_BOUND_MS = {
  posix: POSIX_TERM_GRACE_MS + POSIX_KILL_SETTLE_MS,
  windows: WINDOWS_TREE_KILL_TIMEOUT_MS,
} as const

/** Every process this app started whose tree may still be alive. */
const owned = new Set<StreamingChild>()

/** Track `child` until it has closed and any termination of its tree settled. */
function own(child: StreamingChild): StreamingChild {
  owned.add(child)
  let released = false
  const release = () => {
    if (released) return
    released = true
    void Promise.resolve(child.termination).then(() => { owned.delete(child) })
  }
  child.once('close', release)
  child.once('error', release)
  return child
}

/**
 * Kill every owned process tree at once, synchronously, for a forced exit that
 * will not wait for any termination to settle: the process groups on macOS and
 * Linux, the direct children on Windows (a forced exit adds no taskkill). A
 * download tool must not outlive the app that owned it.
 */
export function killOwnedProcessesNow(): void {
  for (const child of owned) {
    const pid = child.pid
    if (pid === undefined) continue
    if (process.platform !== 'win32') {
      try { process.kill(-pid, 'SIGKILL') } catch { /* the group is gone */ }
    }
    try { child.kill('SIGKILL') } catch { /* already exited */ }
  }
}

/** Terminate the process we started and every descendant it owns. yt-dlp starts
 * ffmpeg and Deno; killing only yt-dlp lets those children keep mutating files
 * after Cancel has returned. Windows uses native `taskkill /T`; POSIX children
 * own a detached process group that is signalled and then escalated as a unit. */
function terminateOwnedProcessTree(child: StreamingChild): Promise<void> {
  const pid = child.pid
  if (process.platform === 'win32' && pid !== undefined) {
    return new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const fallback = () => {
        // Covers taskkill launch/failure and the parent-close race. The direct kill
        // is harmless if taskkill already terminated the parent; importantly, the
        // taskkill process itself is still awaited before cancellation settles.
        child.kill('SIGTERM')
      }
      const timer = setTimeout(() => {
        // Bound the helper too: an unhealthy taskkill must not make Cancel hang
        // forever. Stop it, make the direct best-effort fallback, then settle.
        killer.kill()
        fallback()
        finish()
      }, WINDOWS_TREE_KILL_TIMEOUT_MS)

      killer.once('error', () => {
        fallback()
        finish()
      })
      killer.once('close', (code) => {
        if (code !== 0) fallback()
        finish()
      })
    })
  }
  if (pid === undefined) {
    child.kill('SIGTERM')
    return Promise.resolve()
  }

  return new Promise<void>((resolve) => {
    let settled = false
    let termTimer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    let livenessTimer: NodeJS.Timeout | undefined
    const finish = () => {
      if (settled) return
      settled = true
      if (termTimer) clearTimeout(termTimer)
      if (killTimer) clearTimeout(killTimer)
      if (livenessTimer) clearInterval(livenessTimer)
      resolve()
    }
    const groupIsAlive = () => {
      try {
        process.kill(-pid, 0)
        return true
      } catch {
        return false
      }
    }
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        // Non-Windows children are spawned detached below, making their pid the
        // process-group id. Signal the whole owned group so yt-dlp wrappers cannot
        // leave ffmpeg/Deno descendants mutating the library after Cancel settles.
        process.kill(-pid, signal)
      } catch {
        child.kill(signal)
      }
    }

    signalGroup('SIGTERM')
    // The direct child can obey SIGTERM while an ffmpeg/Deno descendant ignores
    // it. Child close is therefore not the ownership boundary: retain the group
    // id and poll its liveness until every member exits or escalation settles.
    livenessTimer = setInterval(() => {
      if (!groupIsAlive()) finish()
    }, 25)
    termTimer = setTimeout(() => {
      if (!groupIsAlive()) {
        finish()
        return
      }
      signalGroup('SIGKILL')
      // SIGKILL should close promptly. Bound the bookkeeping as well so an OS
      // anomaly cannot leave the termination promise itself pending forever.
      killTimer = setTimeout(finish, POSIX_KILL_SETTLE_MS)
    }, POSIX_TERM_GRACE_MS)
  })
}

function beginTermination(child: StreamingChild): void {
  child.termination ??= terminateOwnedProcessTree(child)
}

async function awaitTermination(child: StreamingChild): Promise<void> {
  await child.termination
}

function bindAbort(child: StreamingChild, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {}
  const onAbort = () => {
    child.abortError = signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError')
    beginTermination(child)
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
      beginTermination(child)
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
  const child = own(spawn(command, args as string[], {
    env: opts.env,
    cwd: opts.cwd,
    ...(opts.windowsHide === undefined ? {} : { windowsHide: opts.windowsHide }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  }) as StreamingChild)

  let stdout = ''
  let stderr = ''
  let idleError: IdleTimeoutError | null = null

  const idle = startIdleWatch(child, opts.idleTimeoutMs, () => {
    idleError = new IdleTimeoutError(command, opts.idleTimeoutMs!)
  })
  const unbindAbort = bindAbort(child, opts.signal)

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (text: string) => { stdout += text; idle.kick() })
  child.stderr.on('data', (text: string) => { stderr += text; idle.kick() })

  return new Promise<CaptureResult>((resolve, reject) => {
    child.on('error', (err) => {
      idle.stop()
      unbindAbort()
      void awaitTermination(child).then(() => reject(child.abortError ?? err))
    })
    child.on('close', (code) => {
      idle.stop()
      unbindAbort()
      void awaitTermination(child).then(() => {
        if (child.abortError) return reject(child.abortError)
        if (idleError) return reject(idleError)
        const result: CaptureResult = { stdout, stderr, exitCode: code }
        if (code === 0 || opts.reject === false) resolve(result)
        else reject(new SubprocessError(command, code, stderr))
      })
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
  const child = own(spawn(command, args as string[], {
    env: opts.env,
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  }) as StreamingChild)

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
    child.on('error', (err) => {
      void awaitTermination(child).then(() => reject(child.abortError ?? err))
    })
    child.on('close', (code) => {
      void awaitTermination(child).then(() => {
        // An idle timeout killed the process — surface that as the cause rather than a
        // generic non-zero exit.
        if (child.idleError) return reject(child.idleError)
        if (child.abortError) return reject(child.abortError)
        if (code === 0 || opts.reject === false) resolve(code)
        else reject(new SubprocessError(opts.command ?? 'process', code, ''))
      })
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
 *   const stdout = makeLineBuffer((line) => parse(line))
 *   const stderr = makeLineBuffer((line) => parse(line))
 *   child.stdout.on('data', stdout.feed)
 *   child.stderr.on('data', stderr.feed)
 *   await waitForExit(child)
 *   stdout.flush()  // emit each pipe's trailing line without joining remainders
 *   stderr.flush()
 */
export function makeLineBuffer(onLine: (line: string) => void): {
  feed: (chunk: Buffer | string) => void
  flush: () => void
} {
  let buf = ''
  const decoder = new StringDecoder('utf8')
  return {
    feed(chunk) {
      buf += decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      const parts = buf.split('\n')
      // The last part is the (possibly partial) remainder — keep it buffered.
      buf = parts.pop() ?? ''
      for (const p of parts) onLine(p.replace(/\r$/, ''))
    },
    flush() {
      buf += decoder.end()
      if (buf.length > 0) {
        onLine(buf.replace(/\r$/, ''))
        buf = ''
      }
    },
  }
}

export type RunFacts = {
  startedAtUtc: string
  /** Monotonic execution time, captured at close; unknown while still running. */
  elapsedMs: () => number | null
  /** The exit code and signal once the child has closed; both null before. */
  exit: () => { code: number | null; signal: NodeJS.Signals | null }
  /** Why TapeBox ended the run early, or null when it did not. */
  stop: () => RunStop | null
}

/** A child whose execution facts remain owned until close. */
export type OutputChild = {
  stdout: Readable
  stderr: Readable
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  idleError?: IdleTimeoutError | null
  abortError?: Error | null
}

export function collectRunFacts(child: OutputChild): RunFacts {
  const startedAtUtc = nowUtcIso()
  const started = performance.now()
  let elapsedMs: number | null = null
  let exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null }
  child.once('close', (code, signal) => {
    elapsedMs = performance.now() - started
    exit = { code, signal }
  })
  return {
    startedAtUtc,
    elapsedMs: () => elapsedMs,
    exit: () => exit,
    stop: () => {
      if (child.idleError) return 'idle'
      return child.abortError instanceof StopRequest ? child.abortError.by : null
    },
  }
}
