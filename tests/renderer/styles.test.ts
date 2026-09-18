import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve('src/renderer/styles/globals.css'), 'utf8')
const compact = css.replace(/\s+/g, '')

describe('renderer scrollbar contract', () => {
  it('keeps a 16px gutter around a 10px inset thumb', () => {
    expect(compact).toMatch(/::-webkit-scrollbar\{[^}]*width:16px;[^}]*height:16px/)
    expect(compact).toMatch(/::-webkit-scrollbar-thumb\{[^}]*border:3pxsolidtransparent/)
    expect(compact).toContain('scrollbar-width:auto')
  })

  it('uses the theme scroll-bar tokens and strengthens the whole owner in use', () => {
    expect(compact).toContain('background-color:var(--color-scrollbar-thumb)')
    expect(compact).toContain('background-color:var(--color-scrollbar-thumb-hover)')
    expect(compact).toContain('*:hover::-webkit-scrollbar-thumb')
    expect(compact).toContain('*:focus-within::-webkit-scrollbar-thumb')
    expect(compact).toContain('scrollbar-gutter:stable')
  })
})
