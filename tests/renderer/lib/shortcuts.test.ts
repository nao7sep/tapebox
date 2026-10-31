// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { matchShortcut, SHORTCUT_GROUPS, SHORTCUTS, shortcutKeys } from '@renderer/lib/shortcuts'

// One table drives both the bindings and the shortcuts list, so these pin how a
// table entry matches keys and how the list writes it.

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)

describe('matching a shortcut', () => {
  it('seeks with the arrows or YouTube\'s J/L in either case, and nothing held', () => {
    expect(matchShortcut(SHORTCUTS.seek, key({ key: 'ArrowLeft' }))).toBe(0)
    expect(matchShortcut(SHORTCUTS.seek, key({ key: 'J' }))).toBe(0)
    expect(matchShortcut(SHORTCUTS.seek, key({ key: 'l' }))).toBe(1)
    expect(matchShortcut(SHORTCUTS.seek, key({ key: 'ArrowRight', shiftKey: true }))).toBe(-1)
    expect(matchShortcut(SHORTCUTS.seek, key({ key: 'j', metaKey: true }))).toBe(-1)
    expect(matchShortcut(SHORTCUTS.seek, key({ key: 'ArrowLeft', altKey: true }))).toBe(-1)
    expect(matchShortcut(SHORTCUTS.seek, key({ key: 'k' }))).toBe(-1)
  })

  it('takes either Cmd or Ctrl for the modifier, and Shift where it is tolerated', () => {
    expect(matchShortcut(SHORTCUTS.inbox, key({ key: '1', metaKey: true }))).toBe(0)
    expect(matchShortcut(SHORTCUTS.inbox, key({ key: '1', ctrlKey: true }))).toBe(0)
    expect(matchShortcut(SHORTCUTS.inbox, key({ key: '1' }))).toBe(-1)
    expect(matchShortcut(SHORTCUTS.showList, key({ key: '/', ctrlKey: true, shiftKey: true }))).toBe(0)
    expect(matchShortcut(SHORTCUTS.showList, key({ key: '?', shiftKey: true }))).toBe(1)
    expect(matchShortcut(SHORTCUTS.shelveToggle, key({ key: 'S', shiftKey: true }))).toBe(0)
    expect(matchShortcut(SHORTCUTS.shelveToggle, key({ key: 's', ctrlKey: true }))).toBe(-1)
  })

  it('reorders only with the modifier and Shift held', () => {
    expect(matchShortcut(SHORTCUTS.reorder, key({ key: 'ArrowUp', metaKey: true, shiftKey: true }))).toBe(0)
    expect(matchShortcut(SHORTCUTS.reorder, key({ key: 'ArrowDown', ctrlKey: true, shiftKey: true }))).toBe(1)
    expect(matchShortcut(SHORTCUTS.reorder, key({ key: 'ArrowUp', metaKey: true }))).toBe(-1)
  })

  it('removes with Backspace or Delete, with or without the modifier', () => {
    expect(matchShortcut(SHORTCUTS.remove, key({ key: 'Backspace' }))).toBe(0)
    expect(matchShortcut(SHORTCUTS.remove, key({ key: 'Delete', metaKey: true }))).toBe(1)
  })
})

describe('the shortcuts list', () => {
  it('writes each entry\'s keys with the platform\'s modifier word, a shared modifier once', () => {
    expect(shortcutKeys(SHORTCUTS.reorder, 'Cmd')).toBe('Cmd+Shift+Up / Down')
    expect(shortcutKeys(SHORTCUTS.showList, 'Ctrl')).toBe('Ctrl+Slash / Question')
    expect(shortcutKeys(SHORTCUTS.seek, 'Cmd')).toBe('Left/J / Right/L')
    expect(shortcutKeys(SHORTCUTS.inbox, 'Ctrl')).toBe('Ctrl+1')
    expect(shortcutKeys(SHORTCUTS.remove, 'Cmd')).toBe('Backspace / Delete')
    expect(shortcutKeys(SHORTCUTS.rename, 'Cmd')).toBe('R')
  })

  it('lists every shortcut the bindings use, once', () => {
    const listed = SHORTCUT_GROUPS.flatMap((group) => group.shortcuts)
    expect(new Set(listed)).toEqual(new Set(Object.values(SHORTCUTS)))
    expect(listed).toHaveLength(Object.values(SHORTCUTS).length)
  })
})
