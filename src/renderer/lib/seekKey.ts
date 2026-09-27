/**
 * The player-seek keys: the arrows and YouTube's J/L (keyboard-shortcut-conventions:
 * "prefer keys people already know"). Returns the seek direction, or null when the
 * event isn't a bare seek key. Callers gate typing/modal state themselves
 * (DetailPane's isShortcutBlocked) before reaching this — it only matches the key.
 */
export function seekDirection(e: KeyboardEvent): 1 | -1 | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null
  if (e.key === 'ArrowRight') return 1
  if (e.key === 'ArrowLeft') return -1
  const key = e.key.toLowerCase()
  if (key === 'l') return 1
  if (key === 'j') return -1
  return null
}
