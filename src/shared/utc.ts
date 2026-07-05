/**
 * UTC helpers — pure data transforms, no I/O.
 *
 * Filename timestamp formats follow the playbook:
 *   - 'yyyymmdd-hhmmss-utc' for UTC moments
 *   - 'yyyymmdd-hhmmss-fff-utc' for UTC moments needing millisecond precision
 *     (a filename that can otherwise collide within the same second — a session
 *     log, a backup archive stamp, a quarantine name)
 *   - 'yyyymmdd-utc' for UTC date-only
 * All lowercase; hyphens are the only separator.
 *
 * Internal timestamps in JSON are ISO 8601 with explicit 'Z' (e.g. via
 * Date#toISOString). Keys carrying such values must end with 'Utc' per the
 * playbook (e.g. addedAtUtc, downloadedAtUtc).
 */

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

export function nowUtcIso(): string {
  return new Date().toISOString()
}

export function utcTimestampForFilename(date: Date = new Date()): string {
  const y = date.getUTCFullYear()
  const m = pad(date.getUTCMonth() + 1, 2)
  const d = pad(date.getUTCDate(), 2)
  const hh = pad(date.getUTCHours(), 2)
  const mm = pad(date.getUTCMinutes(), 2)
  const ss = pad(date.getUTCSeconds(), 2)
  return `${y}${m}${d}-${hh}${mm}${ss}-utc`
}

/**
 * Millisecond-precision counterpart to {@link utcTimestampForFilename}:
 * 'yyyymmdd-hhmmss-fff-utc', e.g. `20260610-031542-123-utc`. toISOString()'s
 * fields are already zero-padded, so slicing its first 23 characters (date +
 * time + '.' + millis) and reshaping the punctuation is exact — no separate
 * padding needed.
 */
export function utcTimestampForFilenameMs(date: Date = new Date()): string {
  return `${date.toISOString().slice(0, 23).replaceAll('-', '').replaceAll(':', '').replace('.', '-').replace('T', '-')}-utc`
}
