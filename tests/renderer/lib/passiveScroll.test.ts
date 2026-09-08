import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  handlePassiveScrollKey,
  planPassiveScrollTop,
} from '@renderer/lib/passiveScroll'

describe('planPassiveScrollTop', () => {
  const base = {
    shiftKey: false,
    scrollTop: 100,
    scrollHeight: 1_000,
    clientHeight: 200,
  }

  it('moves by a line or viewport and clamps at the boundaries', () => {
    expect(planPassiveScrollTop({ ...base, key: 'ArrowDown' })).toBe(140)
    expect(planPassiveScrollTop({ ...base, key: 'PageDown' })).toBe(300)
    expect(planPassiveScrollTop({ ...base, key: 'Home' })).toBe(0)
    expect(planPassiveScrollTop({ ...base, key: 'End' })).toBe(800)
    expect(planPassiveScrollTop({ ...base, key: 'PageDown', scrollTop: 750 })).toBe(800)
  })

  it('uses Space and Shift+Space for opposite page directions', () => {
    expect(planPassiveScrollTop({ ...base, key: ' ' })).toBe(300)
    expect(planPassiveScrollTop({ ...base, key: ' ', shiftKey: true })).toBe(0)
  })

  it('ignores unrelated keys and regions without overflow', () => {
    expect(planPassiveScrollTop({ ...base, key: 'Enter' })).toBeNull()
    expect(planPassiveScrollTop({ ...base, key: 'PageDown', scrollHeight: 200 })).toBeNull()
  })
})

describe('handlePassiveScrollKey', () => {
  function keyEvent(
    owner: HTMLElement,
    target: EventTarget = owner,
  ): ReactKeyboardEvent<HTMLElement> {
    return {
      key: 'PageDown',
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      defaultPrevented: false,
      target,
      currentTarget: owner,
      nativeEvent: { isComposing: false },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as ReactKeyboardEvent<HTMLElement>
  }

  it('scrolls and contains a key handled by the focused owner', () => {
    const owner = { scrollTop: 100, scrollHeight: 1_000, clientHeight: 200 } as HTMLElement
    const event = keyEvent(owner)

    handlePassiveScrollKey(event)

    expect(owner.scrollTop).toBe(300)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it('stands down when a descendant owns the key', () => {
    const owner = { scrollTop: 100, scrollHeight: 1_000, clientHeight: 200 } as HTMLElement
    const event = keyEvent(owner, {} as EventTarget)

    handlePassiveScrollKey(event)

    expect(owner.scrollTop).toBe(100)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it('contains a handled key at the boundary so a nested owner cannot scroll its parent', () => {
    const owner = { scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 } as HTMLElement
    const event = keyEvent(owner)

    handlePassiveScrollKey(event)

    expect(owner.scrollTop).toBe(800)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })
})
