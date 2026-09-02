// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { installWindowActivityState } from '../../../src/renderer/lib/windowActivity'

describe('renderer native window activity', () => {
  it('mutes and restores focus chrome from the typed subscription', () => {
    let listener: ((active: boolean) => void) | undefined
    const cleanup = vi.fn()
    const unsubscribe = installWindowActivityState((next) => {
      listener = next
      return cleanup
    }, document.documentElement)

    listener?.(false)
    expect(document.documentElement.hasAttribute('data-window-inactive')).toBe(true)
    listener?.(true)
    expect(document.documentElement.hasAttribute('data-window-inactive')).toBe(false)
    unsubscribe()
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
