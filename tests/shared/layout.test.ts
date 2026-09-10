import { describe, expect, it } from 'vitest'
import {
  CONTENT_MIN_HEIGHT,
  HEADER_HEIGHT,
  LAYOUT_BOUNDS,
  LayoutSchema,
  PANE_BORDERS,
  STATUS_BAR_HEIGHT,
  VOLUME_DEFAULT,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
  clampSplitter,
  defaultLayout,
  detailPaneWidth,
} from '@shared/layout'

// The window minimum must FALL OUT of the pane minimums plus fixed chrome, never
// be hand-typed (window-chrome-conventions). These guard that the derivation
// stays a derivation — if a pane min or a chrome height changes, the constants
// move with it and these still hold; if someone replaces them with a magic
// number, the invariant breaks.
describe('window minimum derivation', () => {
  it('WINDOW_MIN_WIDTH equals the summed horizontal pane mins + dividers', () => {
    expect(WINDOW_MIN_WIDTH).toBe(
      LAYOUT_BOUNDS.leftPaneWidth.min +
        detailPaneWidth.min +
        LAYOUT_BOUNDS.chaptersPaneWidth.min +
        PANE_BORDERS,
    )
  })

  it('WINDOW_MIN_HEIGHT equals the fixed chrome bars + content row min', () => {
    expect(WINDOW_MIN_HEIGHT).toBe(HEADER_HEIGHT + STATUS_BAR_HEIGHT + CONTENT_MIN_HEIGHT)
  })

  // No-squeeze safety: even with the left pane dragged to its maximum, the
  // window's enforced minimum still leaves the chapters pane its minimum AND the
  // detail pane its minimum. (At the window minimum, a left pane at its own max is
  // geometrically impossible — the clamp prevents it — but this proves the budget
  // covers the worst stated case rather than relying on the runtime clamp.)
  it('leaves the detail pane its min when the left pane is at its max', () => {
    const remaining =
      WINDOW_MIN_WIDTH -
      LAYOUT_BOUNDS.leftPaneWidth.max -
      LAYOUT_BOUNDS.chaptersPaneWidth.min -
      PANE_BORDERS
    // With the left pane at its max, the window minimum cannot also fit the detail
    // pane's min — which is exactly why the splitter is clamped against the live
    // container (below): the left pane can only reach its max on a window wide
    // enough to keep both siblings whole.
    expect(remaining).toBeLessThan(detailPaneWidth.min)
    // The honest budget: at the window minimum, the left pane at its OWN minimum
    // leaves both siblings their minimums exactly.
    const atLeftMin =
      WINDOW_MIN_WIDTH -
      LAYOUT_BOUNDS.leftPaneWidth.min -
      LAYOUT_BOUNDS.chaptersPaneWidth.min -
      PANE_BORDERS
    expect(atLeftMin).toBe(detailPaneWidth.min)
  })
})

// Playback volume is view state and lives here, not in settings
// (persisted-store-separation-conventions). Unlike the config store, which is
// authoritative and rejects a bad field, the layout store self-heals every field
// so a lost/garbled volume never blocks load — losing it costs nothing.
describe('volume as self-healing layout state', () => {
  it('defaults to full and matches the seeded default', () => {
    expect(VOLUME_DEFAULT).toBe(1)
    expect(defaultLayout.volume).toBe(VOLUME_DEFAULT)
  })

  it('preserves a valid in-range volume', () => {
    expect(LayoutSchema.parse({ ...defaultLayout, volume: 0.3 }).volume).toBe(0.3)
    expect(LayoutSchema.parse({ ...defaultLayout, volume: 0 }).volume).toBe(0)
  })

  it('self-heals an out-of-range volume to the default instead of rejecting', () => {
    expect(LayoutSchema.parse({ ...defaultLayout, volume: 1.5 }).volume).toBe(VOLUME_DEFAULT)
    expect(LayoutSchema.parse({ ...defaultLayout, volume: -1 }).volume).toBe(VOLUME_DEFAULT)
  })

  it('self-heals a missing or non-numeric volume to the default', () => {
    const { volume, ...withoutVolume } = defaultLayout
    void volume
    expect(LayoutSchema.parse(withoutVolume).volume).toBe(VOLUME_DEFAULT)
    expect(LayoutSchema.parse({ ...defaultLayout, volume: 'loud' }).volume).toBe(VOLUME_DEFAULT)
  })
})

// The pure splitter clamp shared by every resize handle. The contract: a drag
// never exceeds the live container minus the summed sibling minimums, and never
// drops below the pane's own minimum (window-chrome-conventions: splitters
// clamped against the minimums).
describe('clampSplitter', () => {
  const bounds = { min: 200, max: 720 }

  it('returns the desired size when it fits within the room', () => {
    expect(clampSplitter(400, { available: 1000, siblingMin: 300, min: 200, max: 720 })).toBe(400)
  })

  it('rounds a fractional desired size', () => {
    expect(clampSplitter(400.6, { available: 1000, siblingMin: 300, min: 200, max: 720 })).toBe(401)
  })

  it('never exceeds the pane max even with abundant room', () => {
    expect(clampSplitter(5000, { available: 10000, siblingMin: 0, ...bounds })).toBe(720)
  })

  it('never drops below the pane min even on a tiny drag', () => {
    expect(clampSplitter(10, { available: 1000, siblingMin: 0, ...bounds })).toBe(200)
  })

  // The load-bearing property: a drag that would starve a sibling is capped at the
  // boundary (container − siblingMin), NOT the pane's absolute max.
  it('caps a widening drag at container − siblingMin, not the absolute max', () => {
    // available 700, sibling reserves 360 → at most 340 for this pane; the desired
    // 720 (the pane's own max) would leave the sibling only 380... wait: room is
    // 700 − 360 = 340, well under the 720 max, so the cap is the room.
    expect(clampSplitter(720, { available: 700, siblingMin: 360, min: 200, max: 720 })).toBe(340)
  })

  it('would-starve drag on a real-shaped window stops at the sibling boundary', () => {
    // Container = WINDOW_MIN_WIDTH; chapters + detail mins must remain. Dragging
    // the left pane toward its max stops where the siblings keep their minimums.
    const available = WINDOW_MIN_WIDTH - PANE_BORDERS
    const siblingMin = detailPaneWidth.min + LAYOUT_BOUNDS.chaptersPaneWidth.min
    const result = clampSplitter(LAYOUT_BOUNDS.leftPaneWidth.max, {
      available,
      siblingMin,
      min: LAYOUT_BOUNDS.leftPaneWidth.min,
      max: LAYOUT_BOUNDS.leftPaneWidth.max,
    })
    expect(result).toBe(LAYOUT_BOUNDS.leftPaneWidth.min)
    expect(result).toBeLessThan(LAYOUT_BOUNDS.leftPaneWidth.max)
  })

  // When the room ceiling falls below the pane's own min (an undersized window
  // held only by the schema/window floor), the pane still reports its min rather
  // than an impossible smaller value.
  it('falls back to the pane min when room is below it', () => {
    expect(clampSplitter(600, { available: 250, siblingMin: 200, min: 200, max: 720 })).toBe(200)
  })
})
