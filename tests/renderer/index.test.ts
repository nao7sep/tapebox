import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The renderer ships a Content-Security-Policy as a <meta http-equiv> tag in
// index.html (Electron renderers have no server to send a header, so the policy
// lives in the document). A bundler step or a careless edit could silently drop
// or weaken it; this guards the production string itself.
//
// Two things matter for script safety: there is no `script-src`, so scripts fall
// back to `default-src 'self'` — strict, with no `'unsafe-inline'` / `'unsafe-eval'`
// — and we keep it that way. The one inline allowance, `style-src 'unsafe-inline'`,
// is a *style* concession (inline styles / Tailwind), not a script one, so the
// strictness checks below target script execution, not the policy blindly.
describe('renderer index.html Content-Security-Policy', () => {
  const html = readFileSync(resolve('src/renderer/index.html'), 'utf8')

  // Pull the content="..." value off the CSP <meta> tag (tag may wrap lines).
  const tag = html.match(/<meta[^>]*Content-Security-Policy[^>]*>/is)?.[0] ?? ''
  const csp = tag.match(/content="([^"]*)"/is)?.[1]?.trim() ?? ''

  it('is present and non-empty', () => {
    expect(csp.length).toBeGreaterThan(0)
  })

  it('is strict: no script may run inline or via eval', () => {
    // No script-src means scripts inherit default-src, which must be 'self'.
    expect(csp).not.toMatch(/script-src/)
    expect(csp).toMatch(/default-src 'self'/)
    // 'unsafe-eval' must appear nowhere in the policy.
    expect(csp).not.toContain("'unsafe-eval'")
    // The only permitted inline allowance is for styles, never anything else.
    const inlineDirectives = csp
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d.includes("'unsafe-inline'"))
      .map((d) => d.split(/\s+/)[0])
    expect(inlineDirectives).toEqual(['style-src'])
  })

  it('matches the exact production policy (snapshot guard)', () => {
    // Snapshot of the current production CSP. Any drop, reorder, or weakening of a
    // directive fails here; update this only with a deliberate, reviewed change.
    expect(csp).toBe(
      "default-src 'self'; img-src 'self' data: http://127.0.0.1:* https:; media-src 'self' http://127.0.0.1:* https:; style-src 'self' 'unsafe-inline';",
    )
  })
})
