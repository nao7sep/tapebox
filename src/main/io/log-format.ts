import type { LogFields, LogLevel } from '@shared/log'

/**
 * Pure formatting + gating for the logger and the records. Kept free of Electron
 * and filesystem imports so it can be unit-tested directly; the logger
 * (logger.ts) supplies the time, and the records (records.ts) the storage.
 */

/**
 * Build one JSON Lines record: the fixed envelope (time / level / message) plus
 * the event's additional fields, serialized, newline-terminated. This is the
 * line's text form, for the console and the records' text-file fallback.
 *
 * The caller's fields are spread FIRST so the reserved envelope keys always win —
 * a field accidentally (or maliciously, via a forwarded renderer object) named
 * `time` / `level` / `message` can never overwrite the line's own envelope.
 */
export function serializeLogLine(
  time: string,
  level: LogLevel,
  message: string,
  fields: LogFields | undefined,
): string {
  return toJson({ ...fields, time, level, message }) + '\n'
}

const UNSERIALIZABLE = '[unserializable]'

/**
 * JSON text of an object. Total — it never throws: when a value JSON
 * refuses (a cycle, a BigInt, a throwing toJSON), every field that serializes on
 * its own is kept and only the offending one is marked, so a single BigInt can't
 * take the rest of the diagnostics down with it.
 */
export function toJson(record: object): string {
  try {
    return JSON.stringify(record)
  } catch {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      try {
        JSON.stringify(value)
        out[key] = value
      } catch {
        out[key] = UNSERIALIZABLE
      }
    }
    return JSON.stringify(out)
  }
}

/**
 * Debug is developer-only: on from an unpackaged / development build, or when
 * `TAPEBOX_DEBUG=1` is set; off in a packaged release. This is what lets logging
 * be verbose without ever flooding an end user's disk.
 */
export function isDebugEnabled(isPackaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return !isPackaged || env['TAPEBOX_DEBUG'] === '1'
}
