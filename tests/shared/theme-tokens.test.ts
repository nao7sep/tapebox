import { describe, expect, it } from 'vitest'
import { themeTokens } from '@shared/theme-tokens'

const css = `
@theme { --font-sans: x; }
@theme {
  --color-canvas: #ffffff;
  --color-fg: #3f3f46;
}
@layer base {
  @media (prefers-color-scheme: dark) {
    :root {
      --color-canvas: #09090b;
    }
  }
  body { color: var(--color-fg); }
}
`

describe('the theme tokens', () => {
  it('reads the light set from @theme and the dark overrides from the dark block', () => {
    const tokens = themeTokens(css)
    expect(tokens.light).toEqual({ '--color-canvas': '#ffffff', '--color-fg': '#3f3f46' })
    expect(tokens.dark).toEqual({ '--color-canvas': '#09090b', '--color-fg': '#3f3f46' })
  })

  it('refuses a stylesheet without a dark block', () => {
    expect(() => themeTokens('@theme { --color-canvas: #fff; }')).toThrow()
  })
})
