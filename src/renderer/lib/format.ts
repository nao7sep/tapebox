import { message, type Message } from '@shared/i18n/translate'

/**
 * "N chapters", but only when the count is meaningful — more than one. A video
 * with 0 or 1 chapters, or an unknown count (null/undefined, e.g. not yet probed),
 * has nothing worth showing, so this returns null and callers render nothing.
 */
export function chapterCountLabel(count: number | null | undefined): Message | null {
  return count != null && count > 1 ? message('tape.chapters', { count }) : null
}

/**
 * Time formatting for chapter timestamps and durations.
 * Returns 'M:SS' below an hour, 'H:MM:SS' for an hour or more.
 */
export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad2 = (n: number) => n.toString().padStart(2, '0')
  if (h > 0) return `${h}:${pad2(m)}:${pad2(ss)}`
  return `${m}:${pad2(ss)}`
}

// Byte sizes and transfer rates are formatted for the reader's locale by the
// translator (t.bytes, t.bytesPerSecond).
