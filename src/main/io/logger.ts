import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '@main/paths'
import { describeError } from '@shared/error'
import type { LogFields, LogLevel } from '@shared/log'
import { nowUtcIso, utcTimestampForFilenameMs } from '@shared/utc'
import { isDebugEnabled, serializeLogLine } from './log-format'

/**
 * Per-launch session log at ~/.tapebox/logs/{yyyymmdd-hhmmss-fff-utc}.log, one
 * JSON object per line (JSON Lines). A small, hand-rolled logger we fully control:
 *
 *   - Takes a structured object (a short stable `message` plus arbitrary
 *     `fields`), never a pre-rendered string. The logger builds the envelope and
 *     serializes.
 *   - Writes synchronously to an append fd so the lines before a crash actually
 *     reach the OS. `warn` / `error` / `debug` additionally fsync immediately, so
 *     the line you want while diagnosing is on disk now; `info` is left to the OS
 *     to flush for efficiency.
 *   - `debug` is developer-only (see isDebugEnabled): the firehose is free in
 *     development and silent in a release, so coverage can be verbose without
 *     ever flooding a user's disk.
 *   - Never throws and never crashes the app. If the file cannot be opened or
 *     written it degrades to the console and keeps running, surfacing the failure
 *     rather than swallowing it. The fallback adds no dependencies.
 *
 * The main process owns the file; the sandboxed renderer forwards objects over
 * IPC (see ipc/log.ts), which call straight into this logger.
 */

// Field names whose values are replaced with "[redacted]" before serialization —
// exact, case-insensitive, lowercased here. Seeded with the obvious secrets and
// extended as new secret-bearing fields appear. This is a narrow backstop; the
// primary defense against logging secrets is summarizing rather than dumping.
export const DENIED_KEYS: ReadonlySet<string> = new Set([
  'apikey',
  'authorization',
  'token',
  'password',
  'secret',
])

let fd: number | null = null
let currentLogPath: string | null = null
let debugEnabled = false

export type LoggerOptions = {
  /** Whether debug-level events are written (a dev build, or TAPEBOX_DEBUG=1). */
  debug: boolean
}

export { isDebugEnabled }

/** Whether debug-level events are currently being written (for the renderer gate). */
export function getDebugEnabled(): boolean {
  return debugEnabled
}

/** Open this launch's session file. Returns its intended absolute path. */
export function initLogger(options: LoggerOptions): string {
  debugEnabled = options.debug
  const path = join(paths.logs, `${utcTimestampForFilenameMs()}.log`)
  try {
    fd = openSync(path, 'a')
    currentLogPath = path
  } catch (err) {
    // No file — currentLogPath stays null so app:revealLog never points at a
    // file that was never created. Fall back to the console, and never silently.
    fd = null
    currentLogPath = null
    consoleFallback(
      'error',
      serializeLogLine(nowUtcIso(), 'error', 'log file open failed; using console', {
        path,
        error: describeError(err),
      }, DENIED_KEYS),
    )
  }
  return path
}

/**
 * Absolute path of this launch's log file, or null before initLogger ran OR when
 * the file could not be opened (in which case logging fell back to the console).
 */
export function getCurrentLogPath(): string | null {
  return currentLogPath
}

/**
 * Flush and close the session file. Idempotent and synchronous, so it is safe to
 * call from a process 'exit' handler where only synchronous work runs.
 */
export function closeLogger(): void {
  const f = fd
  fd = null
  if (f === null) return
  try {
    fsyncSync(f)
  } catch {
    // best-effort flush
  }
  try {
    closeSync(f)
  } catch {
    // best-effort close
  }
}

function write(level: LogLevel, message: string, fields?: LogFields): void {
  if (level === 'debug' && !debugEnabled) return

  const line = serializeLogLine(nowUtcIso(), level, message, fields, DENIED_KEYS)
  const flushNow = level !== 'info' // warn / error / debug are durable immediately

  const f = fd
  if (f !== null) {
    try {
      writeSync(f, line)
      if (flushNow) fsyncSync(f)
    } catch (err) {
      // Disk full / fd lost mid-run: stop using the file and degrade to the
      // console — for this line and every later one — without crashing.
      fd = null
      consoleFallback(
        'error',
        serializeLogLine(nowUtcIso(), 'error', 'log file write failed; using console', {
          error: describeError(err),
        }, DENIED_KEYS),
      )
      consoleFallback(level, line)
      return
    }
  }

  // Console: the mandated fallback when there is no file, and in development a
  // mirror for visibility. A healthy file in a release keeps stdout clean.
  if (f === null || debugEnabled) consoleFallback(level, line)
}

function consoleFallback(level: LogLevel, line: string): void {
  const text = line.endsWith('\n') ? line.slice(0, -1) : line
  try {
    if (level === 'error') console.error(text)
    else if (level === 'warn') console.warn(text)
    else console.log(text)
  } catch {
    // If even the console is gone there is nothing left to try — never throw.
  }
}

export const log = {
  debug: (message: string, fields?: LogFields) => write('debug', message, fields),
  info: (message: string, fields?: LogFields) => write('info', message, fields),
  warn: (message: string, fields?: LogFields) => write('warn', message, fields),
  error: (message: string, fields?: LogFields) => write('error', message, fields),
}
