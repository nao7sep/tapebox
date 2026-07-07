import { describe, expect, it } from 'vitest'
import { windowOptions } from '@main/window-options'
import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from '@shared/layout'

// The window's minimum size must be the DERIVED layout floor, not a hand-typed
// magic number (window-chrome-conventions). These assert the main process
// consumes the derived constants verbatim — so the OS-enforced minimum can never
// drift from the pane minimums the layout reserves.
describe('windowOptions', () => {
  it('uses the derived window minimums, not magic literals', () => {
    const opts = windowOptions('/preload.cjs')
    expect(opts.minWidth).toBe(WINDOW_MIN_WIDTH)
    expect(opts.minHeight).toBe(WINDOW_MIN_HEIGHT)
    // The retired band-aids must be gone.
    expect(opts.minWidth).not.toBe(900)
    expect(opts.minHeight).not.toBe(600)
  })

  it('opens at the designed default size (persistence is off)', () => {
    const opts = windowOptions('/preload.cjs')
    expect(opts.width).toBe(1280)
    expect(opts.height).toBe(800)
  })

  it('threads the preload path through to webPreferences', () => {
    const opts = windowOptions('/some/preload.cjs')
    expect(opts.webPreferences?.preload).toBe('/some/preload.cjs')
  })
})
