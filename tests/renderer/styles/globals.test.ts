import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The web half of the scroll-bar rule needs BOTH the styled pseudo-elements AND a
// color-scheme declaration (window-chrome-conventions): the styling shapes the
// bar; color-scheme tells the platform the page is dark so native form controls
// and the scroll-corner square render in the dark palette. The pseudo-element
// styling is already present and verified by review; this guards the declaration
// that pairs with it, so a future edit can't silently drop it back to a
// pasted-on-light default.
describe('globals.css window-chrome compliance', () => {
  const css = readFileSync(resolve('src/renderer/styles/globals.css'), 'utf8')

  it('declares color-scheme: dark', () => {
    expect(css).toMatch(/color-scheme:\s*dark/)
  })

  it('still styles the scroll-bar thumb (the other half of the rule)', () => {
    expect(css).toContain('::-webkit-scrollbar-thumb')
  })

  // app-chrome-conventions: every app sets its fonts explicitly rather than
  // inheriting the toolkit default. The UI font (--font-sans) must be an explicit
  // stack — it is also the variable the Settings "UI font" field overrides at
  // runtime — and the read-only log/args face (--font-mono) must be explicit too.
  it('sets explicit --font-sans (UI) and --font-mono (logs) in @theme', () => {
    expect(css).toMatch(/--font-sans:\s*system-ui/)
    expect(css).toMatch(/--font-mono:\s*[^;]+monospace/)
  })

  it('keeps the normal UI tiers at 12px and 14px', () => {
    expect(css).toMatch(/--text-xs:\s*0\.75rem/)
    expect(css).toMatch(/--text-sm:\s*0\.875rem/)
  })
})
