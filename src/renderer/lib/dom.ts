/**
 * True when the node is a text-entry control — an input, textarea, select, or any
 * contentEditable element. Used to keep global keyboard shortcuts and focus moves
 * from interfering while the user is typing (e.g. the archive search box).
 */
export function isEditableElement(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false
  const tag = node.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable
}

/**
 * True when a global keyboard shortcut should stand down: a modal owns the keyboard,
 * or the user is typing in a text field. The single gate every window-level shortcut
 * handler (list nav, per-tape keys, app nav) checks, so they all defer consistently.
 */
export function isShortcutBlocked(target: EventTarget | null): boolean {
  if (document.querySelector('[data-dialog-surface]')) return true
  return isEditableElement(target)
}
