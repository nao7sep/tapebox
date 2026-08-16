/**
 * The one shared command-modifier predicate (keyboard-shortcut-conventions):
 * BOTH Cmd and Ctrl fire on every platform, and Alt is excluded because
 * Chromium delivers Windows AltGr as Ctrl+Alt — an unguarded predicate would
 * let an AltGr-typed character (unmapped combos fall back to the base key)
 * fire an accelerator and swallow the character. Every accelerator site
 * imports this; a per-file copy is what lets two chords disagree.
 */
export function hasMod(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey
}
