/**
 * "N chapters", but only when the count is meaningful — more than one. A video
 * with 0 or 1 chapters, or an unknown count (null/undefined, e.g. not yet probed),
 * has nothing worth showing, so this returns null and callers render nothing.
 */
export function chapterCountLabel(count: number | null | undefined): string | null {
  return count != null && count > 1 ? `${count} chapters` : null
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

/** Human-readable byte size, e.g. 142 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

/** Human-readable transfer rate, e.g. 4.2 MB/s. */
export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}
