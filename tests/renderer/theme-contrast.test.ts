import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Every color pair the renderer draws must meet WCAG AA in both themes
// (app-chrome conventions, Theme): 4.5:1 for text, 3:1 for a field's outline and
// focus border, the focus and selection rings, icons, and the scroll-bar thumb.
// Light values live in globals.css's color @theme block; dark values in the :root
// block inside @media (prefers-color-scheme: dark). A translucent token carries
// its alpha in an eight-digit hex and is composited over the surface it sits on.
const css = readFileSync(resolve('src/renderer/styles/globals.css'), 'utf8')

type Rgb = [number, number, number]
type Rgba = [number, number, number, number]

function themeBlock(theme: 'light' | 'dark'): string {
  if (theme === 'light') {
    const start = css.indexOf('@theme {\n  /* The window')
    expect(start, 'the light colors must be the color @theme block').toBeGreaterThanOrEqual(0)
    return css.slice(start, css.indexOf('\n}', start))
  }
  const media = css.indexOf('@media (prefers-color-scheme: dark) {')
  expect(media, 'the dark theme must be a prefers-color-scheme block').toBeGreaterThanOrEqual(0)
  return css.slice(media, css.indexOf('\n    }', media))
}

function colorOf(block: string, token: string): Rgba {
  const value = block.match(new RegExp(`--color-${token}:\\s*(#[0-9a-f]{6}(?:[0-9a-f]{2})?);`, 'i'))?.[1]
  expect(value, `--color-${token} must be a six- or eight-digit hex color`).toBeTruthy()
  const channel = (offset: number) => Number.parseInt(value!.slice(offset, offset + 2), 16)
  return [channel(1), channel(3), channel(5), value!.length === 9 ? channel(7) / 255 : 1]
}

function over([r, g, b, a]: Rgba, base: Rgb): Rgb {
  return [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)]
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(first: Rgb, second: Rgb): number {
  const a = luminance(first)
  const b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

// The two opaque grounds everything else sits on: the window and a modal or menu.
const GROUNDS = ['canvas', 'panel']
// Neutral fills and the text each carries, over both grounds. The hover fills
// behind icon buttons and the disabled primary carry only body-weight text; the
// selected box row adds its muted count; the subtle tier (placeholders, empty
// values) sits only on resting surfaces.
const RESTING = ['canvas', 'panel', 'raised', 'hover', 'sticky', 'row', 'row-archived', 'neutral-tint']
const TEXT_ON: Record<string, string[]> = {
  'fg-strong': [...RESTING, 'raised-hover', 'hover-strong', 'info-selected'],
  'fg-emphasis': [...RESTING, 'raised-hover', 'hover-strong', 'info-selected'],
  fg: [...RESTING, 'raised-hover', 'hover-strong', 'info-selected'],
  'fg-muted': [...RESTING, 'info-selected'],
  'fg-subtle': RESTING,
}
// Each status family's text over the grounds and over its own tints.
const STATUS: Record<string, string[]> = {
  danger: ['tint', 'row'],
  warning: ['tint', 'row'],
  info: ['row'],
  calm: ['tint', 'row'],
  note: ['tint', 'row'],
}

describe('theme token contrast', () => {
  for (const theme of ['light', 'dark'] as const) describe(`${theme} theme`, () => {
    const block = themeBlock(theme)
    // Collects every shortfall so one run lists them all.
    let failures: string[] = []
    const check = (ink: string, fill: string, floor: number) => {
      for (const ground of GROUNDS) {
        const background = over(colorOf(block, fill), over(colorOf(block, ground), [0, 0, 0]))
        const ratio = contrast(over(colorOf(block, ink), background), background)
        if (ratio < floor) failures.push(`${ink} on ${fill} over ${ground}: ${ratio.toFixed(2)}`)
      }
    }
    beforeEach(() => {
      failures = []
    })
    afterEach(() => {
      expect(failures.join('\n'), `pairs below the floor in ${theme}`).toBe('')
    })

    it('keeps neutral text at 4.5:1 or more on every neutral fill', () => {
      for (const [ink, fills] of Object.entries(TEXT_ON)) for (const fill of fills) check(ink, fill, 4.5)
    })

    it('keeps text on filled buttons and chips at 4.5:1 or more', () => {
      check('on-inverse', 'inverse', 4.5)
      check('on-inverse', 'inverse-hover', 4.5)
      check('on-danger', 'danger-fill', 4.5)
      check('on-danger', 'danger-fill-hover', 4.5)
      check('on-warm', 'warm-fill', 4.5)
      check('on-warm', 'warm-fill-hover', 4.5)
    })

    it('keeps status text at 4.5:1 or more on the grounds, its tints, and its banners', () => {
      for (const [family, tints] of Object.entries(STATUS)) {
        for (const fill of [...GROUNDS, ...tints.map((tint) => `${family}-${tint}`)]) check(`${family}-fg`, fill, 4.5)
      }
      for (const family of ['danger', 'warning', 'info']) {
        check(`${family}-fg-strong`, `${family}-banner`, 4.5)
        check(`${family}-fg-strong`, `${family}-hover`, 4.5)
      }
      check('fg-emphasis', 'calm-tint', 4.5)
      check('danger-fg', 'hover-strong', 4.5)
    })

    it('keeps field outlines, focus, selection, drop rings, icons, and the scroll-bar thumb at 3:1 or more', () => {
      for (const mark of ['field-line', 'field-focus', 'focus', 'selected', 'danger-line-hover', 'danger-fg', 'info-ring', 'warning-ring', 'autoplay-on', 'sound-on', 'scrollbar-thumb']) {
        check(mark, 'canvas', 3)
        check(mark, 'panel', 3)
      }
    })
  })

  it('defines every light color again in the dark block', () => {
    const tokens = (block: string) => new Set([...block.matchAll(/--color-([a-z0-9-]+):/g)].map((match) => match[1]))
    const dark = tokens(themeBlock('dark'))
    for (const token of tokens(themeBlock('light'))) expect(dark.has(token), `--color-${token} in the dark theme`).toBe(true)
  })
})

// Components name a color by its role, never by Tailwind's literal palette, so
// both themes stay one token set each (app-chrome conventions, Theme).
describe('renderer color classes', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) return sources(path)
      return /\.(tsx?|html)$/.test(entry) ? [path] : []
    })
  }

  it('use only semantic theme colors', () => {
    const literal = /(?<![\w-])(?:bg|text|border|ring|outline|placeholder|divide|fill|stroke|from|via|to|accent|caret|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g
    const found = sources(resolve('src/renderer')).flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(literal)].map((match) => `${path}: ${match[0]}`))
    expect(found).toEqual([])
  })
})
