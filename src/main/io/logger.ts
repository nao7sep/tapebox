import type { LogFields, LogLevel } from '@shared/log'
import { nowUtcIso } from '@shared/utc'
import { isDebugEnabled, serializeLogLine, toJson } from './log-format'
import { toConsole, writeRecord } from './records'

/**
 * The app's logger, per the logging conventions: each line is a row in the
 * records database's `logs` table (io/records.ts), which also owns the fallback
 * when a row cannot be written. A small, hand-rolled logger we fully control:
 *
 *   - Takes a structured object (a short stable `message` plus arbitrary
 *     `fields`), never a pre-rendered string. A string `tapeId` field also fills
 *     the row's `tape_id`, so one tape's lines are a query.
 *   - `debug` is developer-only (see isDebugEnabled): the firehose is free in
 *     development and silent in a release, and development mirrors every line to
 *     the console.
 *   - Never throws and never crashes the app.
 *
 * The sandboxed renderer forwards objects over IPC (see ipc/log.ts), which call
 * straight into this logger.
 */

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

export function initLogger(options: LoggerOptions): void {
  debugEnabled = options.debug
}

function write(level: LogLevel, message: string, fields?: LogFields): void {
  if (level === 'debug' && !debugEnabled) return
  const time = nowUtcIso()
  const tapeId = fields?.['tapeId']
  const text = () => serializeLogLine(time, level, message, fields)
  const printed = writeRecord(
    'logs',
    {
      time,
      level,
      message,
      tape_id: typeof tapeId === 'string' ? tapeId : null,
      fields: toJson(fields ?? {}),
    },
    text,
    level,
    debugEnabled,
  )
  if (debugEnabled && !printed) toConsole(level, text())
}

export const log = {
  debug: (message: string, fields?: LogFields) => write('debug', message, fields),
  info: (message: string, fields?: LogFields) => write('info', message, fields),
  warn: (message: string, fields?: LogFields) => write('warn', message, fields),
  error: (message: string, fields?: LogFields) => write('error', message, fields),
}
