import { createWriteStream, WriteStream } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from '@main/paths'
import { nowUtcIso, utcTimestampForFilename } from '@shared/utc'

/**
 * Per-launch log file at ~/.tapebox/logs/{yyyymmdd-hhmmss-utc}.log
 * Filename carries the UTC suffix per playbook; no app-name prefix.
 *
 * Logger is best-effort: file write failures never break the app. Lines are
 * also mirrored to the console for dev visibility.
 */

type Level = 'debug' | 'info' | 'warn' | 'error'

let stream: WriteStream | null = null
let currentPath: string | null = null

export function initLogger(): string {
  const filename = `${utcTimestampForFilename()}.log`
  const path = join(paths.logs, filename)
  stream = createWriteStream(path, { flags: 'a', encoding: 'utf8' })
  currentPath = path
  return path
}

export function closeLogger(): Promise<void> {
  return new Promise((resolve) => {
    const s = stream
    stream = null
    currentPath = null
    if (!s) return resolve()
    s.end(() => resolve())
  })
}

export function currentLogPath(): string | null {
  return currentPath
}

/**
 * Keep the N most recent .log files in ~/.tapebox/logs; delete the rest.
 * Lexicographic sort is correct because filenames start with yyyymmdd-hhmmss.
 */
export async function pruneOldLogs(retainCount: number): Promise<void> {
  if (retainCount < 0) return
  let files: string[]
  try {
    files = await readdir(paths.logs)
  } catch {
    return
  }
  const logs = files.filter((f) => f.endsWith('.log')).sort().reverse()
  for (const old of logs.slice(retainCount)) {
    try {
      await unlink(join(paths.logs, old))
    } catch {
      // ignore — pruning is best-effort
    }
  }
}

function write(level: Level, message: string, meta?: unknown): void {
  const head = `${nowUtcIso()} ${level.toUpperCase()} ${message}`
  const line = meta !== undefined ? `${head} ${JSON.stringify(meta)}\n` : `${head}\n`

  // Console mirror for dev.
  if (level === 'error') console.error(line.trimEnd())
  else if (level === 'warn') console.warn(line.trimEnd())
  else console.log(line.trimEnd())

  stream?.write(line)
}

export const log = {
  debug: (msg: string, meta?: unknown) => write('debug', msg, meta),
  info:  (msg: string, meta?: unknown) => write('info', msg, meta),
  warn:  (msg: string, meta?: unknown) => write('warn', msg, meta),
  error: (msg: string, meta?: unknown) => write('error', msg, meta),
}
