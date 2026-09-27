// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { seekDirection } from '@renderer/lib/seekKey'
import { isEditableElement } from '@renderer/lib/dom'

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

describe('seekDirection', () => {
  it('matches the arrows', () => {
    expect(seekDirection(keydown({ key: 'ArrowLeft' }))).toBe(-1)
    expect(seekDirection(keydown({ key: 'ArrowRight' }))).toBe(1)
  })

  it("matches YouTube's J/L alongside the arrows, case-insensitively", () => {
    expect(seekDirection(keydown({ key: 'j' }))).toBe(-1)
    expect(seekDirection(keydown({ key: 'J' }))).toBe(-1)
    expect(seekDirection(keydown({ key: 'l' }))).toBe(1)
    expect(seekDirection(keydown({ key: 'L' }))).toBe(1)
  })

  it('does not match when a modifier is held', () => {
    expect(seekDirection(keydown({ key: 'j', metaKey: true }))).toBeNull()
    expect(seekDirection(keydown({ key: 'l', ctrlKey: true }))).toBeNull()
    expect(seekDirection(keydown({ key: 'ArrowLeft', altKey: true }))).toBeNull()
    expect(seekDirection(keydown({ key: 'ArrowRight', shiftKey: true }))).toBeNull()
  })

  it('returns null for unrelated keys', () => {
    expect(seekDirection(keydown({ key: 'Enter' }))).toBeNull()
    expect(seekDirection(keydown({ key: 'k' }))).toBeNull()
  })

  // DetailPane gates every per-tape key, seekDirection included, behind
  // isShortcutBlocked before it ever inspects the key (keyboard-shortcut-conventions'
  // editable-target rule) — a text field stands down the J/L seek exactly as it
  // already stands down the arrows.
  it('would stand down in a text field via the shared editable-target guard', () => {
    const input = document.createElement('input')
    expect(isEditableElement(input)).toBe(true)
  })
})
