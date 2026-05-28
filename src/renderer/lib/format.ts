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
