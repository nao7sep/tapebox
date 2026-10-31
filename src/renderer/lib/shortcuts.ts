import type { MessageKey } from '@shared/i18n/catalogues'

/**
 * The app's keyboard shortcuts, in one table: each binding matches through
 * {@link matchShortcut}, and the shortcuts list renders the same entries with
 * {@link shortcutKeys}, so the list cannot drift from what the keys do
 * (keyboard-shortcut-conventions). Key names stay English in every language.
 */

/** Whether a modifier must be held, must not be, or does not matter. Alt is never part of a shortcut. */
type Hold = 'yes' | 'no' | 'any'

type Chord = {
  /** `KeyboardEvent.key`; letters match in either case. */
  key: string
  /** Cmd on macOS or Ctrl elsewhere (either is accepted everywhere). */
  mod?: Hold
  shift?: Hold
}

export type Shortcut = {
  label: MessageKey
  /** Alternatives the list separates with " / "; the keys within one are equivalent. */
  chords: readonly (readonly Chord[])[]
}

const plain = (key: string): Chord => ({ key, mod: 'no', shift: 'any' })

export const SHORTCUTS = {
  // A list's arrows move its selection whatever is held; Cmd/Ctrl+Shift reorders.
  moveSelection: { label: 'shortcuts.moveSelection', chords: [[{ key: 'ArrowUp', mod: 'any', shift: 'any' }], [{ key: 'ArrowDown', mod: 'any', shift: 'any' }]] },
  reorder: { label: 'shortcuts.reorder', chords: [[{ key: 'ArrowUp', mod: 'yes', shift: 'yes' }], [{ key: 'ArrowDown', mod: 'yes', shift: 'yes' }]] },
  inbox: { label: 'filter.inbox', chords: [[{ key: '1', mod: 'yes', shift: 'any' }]] },
  shelf: { label: 'filter.shelf', chords: [[{ key: '2', mod: 'yes', shift: 'any' }]] },
  searchShelf: { label: 'shortcuts.searchShelf', chords: [[plain('/')]] },
  mainAction: { label: 'shortcuts.mainAction', chords: [[plain('Enter')]] },
  refreshMetadata: { label: 'detail.refreshMetadata', chords: [[plain('m')]] },
  rename: { label: 'detail.rename', chords: [[plain('r')]] },
  export: { label: 'detail.export', chords: [[plain('e')]] },
  shelveToggle: { label: 'shortcuts.shelveToggle', chords: [[plain('s')]] },
  // Backspace or Delete removes, with or without Cmd/Ctrl.
  remove: { label: 'remove.moveToTrash', chords: [[{ key: 'Backspace', mod: 'any', shift: 'any' }], [{ key: 'Delete', mod: 'any', shift: 'any' }]] },
  // YouTube's J and L beside the arrows; Shift+arrow is left to the player.
  seek: {
    label: 'shortcuts.seek',
    chords: [
      [{ key: 'ArrowLeft', mod: 'no', shift: 'no' }, { key: 'j', mod: 'no', shift: 'no' }],
      [{ key: 'ArrowRight', mod: 'no', shift: 'no' }, { key: 'l', mod: 'no', shift: 'no' }],
    ],
  },
  jumpChapter: { label: 'shortcuts.jumpChapter', chords: [[{ key: 'ArrowUp', mod: 'any', shift: 'any' }], [{ key: 'ArrowDown', mod: 'any', shift: 'any' }]] },
  addUrl: { label: 'shortcuts.addUrl', chords: [[{ key: 'Enter', mod: 'any', shift: 'any' }]] },
  // Shift is tolerated so shifted-slash layouts (German QWERTZ) reach the chord.
  showList: { label: 'shortcuts.showList', chords: [[{ key: '/', mod: 'yes', shift: 'any' }], [plain('?')]] },
  closeDialog: { label: 'shortcuts.closeDialog', chords: [[{ key: 'Escape', mod: 'any', shift: 'any' }]] },
} as const satisfies Record<string, Shortcut>

/** The shortcuts list, grouped by where the keys apply. */
export const SHORTCUT_GROUPS: readonly { title: MessageKey; note?: MessageKey; shortcuts: readonly Shortcut[] }[] = [
  {
    title: 'shortcuts.navigate',
    note: 'shortcuts.navigateNote',
    shortcuts: [SHORTCUTS.moveSelection, SHORTCUTS.reorder, SHORTCUTS.inbox, SHORTCUTS.shelf, SHORTCUTS.searchShelf],
  },
  {
    // Same order as the detail-pane button row: primary action, then the
    // housekeeping group (refresh → rename → export), then Shelve, then remove.
    title: 'shortcuts.selectedTape',
    shortcuts: [SHORTCUTS.mainAction, SHORTCUTS.refreshMetadata, SHORTCUTS.rename, SHORTCUTS.export, SHORTCUTS.shelveToggle, SHORTCUTS.remove],
  },
  { title: 'shortcuts.player', note: 'shortcuts.playerNote', shortcuts: [SHORTCUTS.seek, SHORTCUTS.jumpChapter] },
  { title: 'settings.tabGeneral', shortcuts: [SHORTCUTS.addUrl, SHORTCUTS.showList, SHORTCUTS.closeDialog] },
]

type KeyInput = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

function holds(rule: Hold | undefined, held: boolean): boolean {
  const wanted = rule ?? 'no'
  return wanted === 'any' || (wanted === 'yes') === held
}

function chordMatches(chord: Chord, e: KeyInput): boolean {
  const key = chord.key.length === 1 ? e.key.toLowerCase() === chord.key.toLowerCase() : e.key === chord.key
  return key && !e.altKey && holds(chord.mod, e.metaKey || e.ctrlKey) && holds(chord.shift, e.shiftKey)
}

/** Which alternative of `shortcut` the event is (0 for the first), or -1. */
export function matchShortcut(shortcut: Shortcut, e: KeyInput): number {
  return shortcut.chords.findIndex((alternative) => alternative.some((chord) => chordMatches(chord, e)))
}

const KEY_NAMES: Record<string, string> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '/': 'Slash', '?': 'Question',
}

function keyName(key: string): string {
  return KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key)
}

function prefix(chord: Chord, mod: string): string {
  return `${chord.mod === 'yes' ? `${mod}+` : ''}${chord.shift === 'yes' ? 'Shift+' : ''}`
}

/** The keys as the shortcuts list shows them; `mod` is "Cmd" or "Ctrl". A shared
 * modifier is written once: "Cmd+Shift+Up / Down". */
export function shortcutKeys(shortcut: Shortcut, mod: string): string {
  const all = shortcut.chords.flat()
  const shared = all.every((chord) => prefix(chord, mod) === prefix(all[0]!, mod)) ? prefix(all[0]!, mod) : null
  const alternatives = shortcut.chords.map((alternative) =>
    alternative.map((chord) => `${shared === null ? prefix(chord, mod) : ''}${keyName(chord.key)}`).join('/'))
  return `${shared ?? ''}${alternatives.join(' / ')}`
}
