import { describe, expect, it } from 'vitest'
import { windowOptions, windowStatePersistence } from '@main/window-options'
import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from '@shared/layout'

// The OS-enforced minimum is the layout's derived floor, so a pane can never be
// squeezed below what the layout reserves.
describe('windowOptions', () => {
  it('uses the layout\'s window minimums', () => {
    const opts = windowOptions('/preload.cjs', '#ffffff')
    expect(opts.minWidth).toBe(WINDOW_MIN_WIDTH)
    expect(opts.minHeight).toBe(WINDOW_MIN_HEIGHT)
  })

  it('uses Electron bounds persistence with Windows display mode', () => {
    const opts = windowOptions('/preload.cjs', '#ffffff')
    expect(opts.name).toBe('main')
    expect(opts.windowStatePersistence).toEqual(windowStatePersistence())
    expect(windowStatePersistence('win32')).toEqual({ bounds: true, displayMode: true })
    expect(windowStatePersistence('darwin')).toEqual({ bounds: true, displayMode: false })
    expect(windowStatePersistence('linux')).toEqual({ bounds: true, displayMode: false })
  })

  it("paints the background it is given (the resolved theme's canvas)", () => {
    expect(windowOptions('/preload.cjs', '#09090b').backgroundColor).toBe('#09090b')
  })

  it('threads the preload path through to webPreferences', () => {
    const opts = windowOptions('/some/preload.cjs', '#ffffff')
    expect(opts.webPreferences?.preload).toBe('/some/preload.cjs')
  })
})
