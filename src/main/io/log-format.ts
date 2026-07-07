import type { LogFields, LogLevel } from '@shared/log'
import { redact } from './redact'

/**
 * Pure formatting + gating for the logger. Kept free of Electron and filesystem
 * imports so it can be unit-tested directly; the stateful logger (logger.ts)
 * supplies the time, the denied-key set, and the file/console plumbing.
 */

/**
 * Build one JSON Lines record: the fixed envelope (time / level / message) plus
 * the event's additional fields, redacted, serialized, newline-terminated.
 *
 * The caller's fields are spread FIRST so the reserved envelope keys always win —
 * a field accidentally (or maliciously, via a forwarded renderer object) named
 * `time` / `level` / `message` can never overwrite the line's own envelope.
 *
 * Total — it never throws. redact() has already broken any cycles, so the only
 * remaining serialize failure is a value JSON refuses outright (BigInt, a
 * throwing toJSON). In that case it salvages every serializable field and marks
 * just the offending one, rather than dropping the whole diagnostic payload.
 */
export function serializeLogLine(
  time: string,
  level: LogLevel,
  message: string,
  fields: LogFields | undefined,
  deniedKeys: ReadonlySet<string>,
): string {
  const record = redact({ ...fields, time, level, message }, deniedKeys)
  try {
    return JSON.stringify(record) + '\n'
  } catch {
    return JSON.stringify(salvage(record, time, level, message)) + '\n'
  }
}

const UNSERIALIZABLE = '[unserializable]'

/**
 * Rebuild a record keeping every field that serializes on its own and replacing
 * only the ones that don't with a marker — so a single BigInt can't take the
 * rest of the line's diagnostics down with it.
 */
function salvage(
  record: Record<string, unknown>,
  time: string,
  level: LogLevel,
  message: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { time, level, message }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'time' || key === 'level' || key === 'message') continue
    try {
      JSON.stringify(value)
      out[key] = value
    } catch {
      out[key] = UNSERIALIZABLE
    }
  }
  return out
}

/**
 * Debug is developer-only: on from an unpackaged / development build, or when
 * `TAPEBOX_DEBUG=1` is set; off in a packaged release. This is what lets logging
 * be verbose without ever flooding an end user's disk.
 */
export function isDebugEnabled(isPackaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return !isPackaged || env['TAPEBOX_DEBUG'] === '1'
}
