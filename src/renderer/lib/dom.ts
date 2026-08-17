// INPUT types that carry typed text. The rest — checkbox, radio, range and the button
// family — consume no printable key, so a shortcut must NOT stand down for them. A
// visually-hidden radio is exactly how the filter chips are built, and treating one as
// editable killed every shortcut in the app while a chip held focus.
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date',
  'datetime-local', 'month', 'time', 'week',
])

/**
 * True when the node is a text-entry control the user could be typing into. The
 * parentElement WALK is load-bearing: a rich-text target is a descendant of its
 * contenteditable, so a tagName-only test sees a plain DIV and lets every chord
 * through (keyboard-shortcut-conventions' one editable predicate per app).
 */
export function isEditableElement(node: EventTarget | null): boolean {
  let current = node instanceof HTMLElement ? node : null
  while (current) {
    if (current.isContentEditable) return true
    if (current.tagName === 'TEXTAREA') return true
    if (current.tagName === 'INPUT') {
      const type = (current.getAttribute('type') ?? 'text').toLowerCase()
      return TEXT_INPUT_TYPES.has(type)
    }
    current = current.parentElement
  }
  return false
}

/** True while a modal owns the keyboard — every global shortcut stands down. */
export function isModalOpen(): boolean {
  return Boolean(document.querySelector('[data-dialog-surface]'))
}

/**
 * True when a global bare-key shortcut should stand down: a modal owns the keyboard,
 * or the user is typing in a text field. The gate for handlers whose keys are typed
 * text (list nav, per-tape keys). Mod-chords check the two halves separately in
 * useAppShortcuts — the Cmd half fires even while typing.
 */
export function isShortcutBlocked(target: EventTarget | null): boolean {
  return isModalOpen() || isEditableElement(target)
}
