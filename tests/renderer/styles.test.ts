import { readdirSync, readFileSync } from 'node:fs'
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

// Identifying text takes one line and ends in one marker; an existing route shows
// the complete value where it is needed (interface-styling-conventions, Labels).
// New truncation is reviewed here, by file, rather than slipping in with a class
// name; the path for each kept site is recorded beside it.
const REVIEWED_MARKERS: Record<string, number> = {
  // Box rows and Unboxed; renaming shows a name whole.
  'components/BoxList.tsx': 2,
  // Chapter rows; the visible start tells chapters apart, with their times.
  'components/ChapterList.tsx': 1,
  // The one-line heading; Refresh metadata shows the whole title.
  'components/DetailPane.tsx': 1,
  // Fixed-height virtualized rows; the focused or tapped row is shown in full.
  'components/ScanPageModal.tsx': 1,
  // Box headers over search results; renaming in the box list shows them whole.
  'components/SearchResults.tsx': 1,
  // Title and status line; selection shows both in the detail pane.
  'components/TapeRow.tsx': 2,
  // A path's leading part and final segment; callers show the value whole elsewhere.
  'components/PathLine.tsx': 2,
  // Labels past the menu's width cap; renaming in the box list shows box names whole.
  'components/Menu.tsx': 1,
  // Language, time zone and thinking selects; opening one lists the full options.
  'components/SettingsModal.tsx': 3,
  // Row title and text clamp (selection shows the record) and the filter select.
  'records/RecordsWindow.tsx': 3,
}
const MARKER = /^(truncate|text-ellipsis|line-clamp-\d+)$/

function rendererSources(dir = resolve('src/renderer')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    return entry.isDirectory() ? rendererSources(path) : /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('cut-short text', () => {
  const root = resolve('src/renderer') + '/'
  const files = rendererSources().map((path) => ({ name: path.slice(root.length), source: readFileSync(path, 'utf8') }))
  const literals = (source: string) => [...source.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map((match) => match[1] ?? match[2] ?? match[3]!)

  it('keeps truncation markers to the reviewed sites', () => {
    const found: Record<string, number> = {}
    for (const { name, source } of files) {
      const count = literals(source).filter((text) => text.split(/\s+/).some((token) => MARKER.test(token))).length
      if (count > 0) found[name] = count
    }
    expect(found).toEqual(REVIEWED_MARKERS)
  })

  it('never clips nowrap text without a marker', () => {
    const clips = files.flatMap(({ name, source }) => literals(source)
      .filter((text) => {
        const tokens = text.split(/\s+/)
        return tokens.includes('whitespace-nowrap') && tokens.includes('overflow-hidden') && !tokens.some((token) => MARKER.test(token))
      })
      .map((text) => `${name}: ${text}`))
    expect(clips).toEqual([])
  })

  it('gives every select a marker, since Chromium clips a closed select without one', () => {
    // A select's attributes run to its first option; handlers may contain `>`.
    const unmarked = files.flatMap(({ name, source }) => [...source.matchAll(/<select\b[\s\S]*?<option\b/g)]
      .filter((match) => !/\btext-ellipsis\b/.test(match[0]))
      .map(() => name))
    expect(unmarked).toEqual([])
  })

  it('draws no text-overflow from the stylesheet', () => {
    expect(css).not.toMatch(/text-overflow|line-clamp/)
  })
})
