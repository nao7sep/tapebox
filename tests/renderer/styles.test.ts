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

describe('composite row states', () => {
  it('projects keyboard focus onto the whole selected item, including a wrapped box option', () => {
    expect(compact).toContain('[role="listbox"]:focus-visible.listbox-item:is([aria-selected="true"],:has(>[role="option"][aria-selected="true"]))')
    expect(css).toMatch(/\[role="listbox"\]:focus-visible \.listbox-item[^\{]*\{\s*outline: 2px solid var\(--color-focus\);\s*outline-offset: -2px;/)
    expect(css).toMatch(/\[data-window-inactive\] \[role="listbox"\]:focus-visible \.listbox-item[^\{]*\{\s*outline-color: var\(--color-line\);/)
  })

  it('layers hover over the row palette and keeps the selected tape border authoritative', () => {
    expect(compact).toContain('.listbox-item:hover{background-image:linear-gradient(var(--color-item-hover-tint),var(--color-item-hover-tint));}')
    expect(compact).toContain('.tape-row[aria-selected="true"]{border-color:var(--color-selected);}')
    expect(css.match(/--color-item-hover-tint:/g)).toHaveLength(2)
  })
})
