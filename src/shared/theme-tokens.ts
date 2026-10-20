/**
 * The colour tokens globals.css defines, per theme, read from its text: the light
 * set in its `@theme` blocks and the dark overrides under `prefers-color-scheme:
 * dark`. Surfaces outside the renderer's stylesheet, such as the window background
 * and the standalone message dialog, take their colours from here, so a theme
 * change reaches them too.
 */
export type ThemeTokens = { light: Readonly<Record<string, string>>; dark: Readonly<Record<string, string>> }

const DARK_BLOCK = '@media (prefers-color-scheme: dark) {'
const COLOR_TOKEN = /(--color-[\w-]+)\s*:\s*([^;]+);/g

function tokensIn(text: string): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const [, name, value] of text.matchAll(COLOR_TOKEN)) tokens[name!] = value!.trim()
  return tokens
}

/** The block from `start`'s opening brace to its matching close. */
function blockAt(css: string, start: number): string {
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
  }
  throw new Error('unclosed block in the stylesheet')
}

export function themeTokens(css: string): ThemeTokens {
  const darkStart = css.indexOf(DARK_BLOCK)
  if (darkStart < 0) throw new Error('the stylesheet has no dark theme block')
  const light = tokensIn([...css.matchAll(/@theme\s*\{/g)].map((match) => blockAt(css, match.index)).join('\n'))
  const dark = { ...light, ...tokensIn(blockAt(css, darkStart)) }
  return { light, dark }
}
