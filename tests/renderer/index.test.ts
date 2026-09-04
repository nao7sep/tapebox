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
  const directives = new Map<string, Set<string>>()
  for (const clause of csp.split(';').map((part) => part.trim()).filter(Boolean)) {
    const [name, ...values] = clause.split(/\s+/)
    if (directives.has(name!)) throw new Error(`Duplicate CSP directive: ${name}`)
    directives.set(name!, new Set(values))
  }

  it('is present and non-empty', () => {
    expect(csp.length).toBeGreaterThan(0)
  })

  it('is strict: no script may run inline or via eval', () => {
    // No script-src means scripts inherit default-src, which must be 'self'.
    expect(directives.has('script-src')).toBe(false)
    expect(directives.get('default-src')).toEqual(new Set(["'self'"]))
    // 'unsafe-eval' must appear nowhere in the policy.
    expect([...directives.values()].some((values) => values.has("'unsafe-eval'"))).toBe(false)
    // The only permitted inline allowance is for styles, never anything else.
    const inlineDirectives = [...directives]
      .filter(([, values]) => values.has("'unsafe-inline'"))
      .map(([name]) => name)
    expect(inlineDirectives).toEqual(['style-src'])
  })

  it('allows the media sources the local player and importer require', () => {
    const expected = new Set(["'self'", 'http://127.0.0.1:*', 'https:'])
    expect(directives.get('img-src')).toEqual(new Set([...expected, 'data:']))
    expect(directives.get('media-src')).toEqual(expected)
  })
})
