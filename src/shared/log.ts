/**
 * Shared logging types + the pure renderer→main message validator.
 *
 * The renderer is sandboxed and never opens the session file itself; it forwards
 * structured log objects to the main process over the one-way 'log:write'
 * channel, and main (which owns the file) writes them. Main's logger and the
 * renderer's forwarder both speak these types.
 */

/** The four levels, as the single source of truth for both the type and the validator. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

/** Additional structured fields beyond the fixed time/level/message envelope. */
export type LogFields = Record<string, unknown>

/** A log event forwarded renderer → main. */
export type LogMessage = {
  level: LogLevel
  message: string
  fields?: LogFields
}

const LEVELS: ReadonlySet<string> = new Set(LOG_LEVELS)

/**
 * Validate an untrusted payload off the IPC boundary into a LogMessage, or null
 * if malformed. A renderer must never be able to wedge logging by sending
 * garbage: the level must be one of the four, the message a string, and `fields`
 * — if present — a plain object. Arrays are rejected (an array is typeof
 * 'object' but spreading it would write index-keyed junk into the log line).
 * Pure and node-free so it is unit-testable without Electron.
 */
export function parseLogMessage(value: unknown): LogMessage | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v['level'] !== 'string' || !LEVELS.has(v['level'])) return null
  if (typeof v['message'] !== 'string') return null
  const fields = v['fields']
  if (fields !== undefined && (typeof fields !== 'object' || fields === null || Array.isArray(fields))) {
    return null
  }
  return { level: v['level'] as LogLevel, message: v['message'], fields: fields as LogFields | undefined }
}
