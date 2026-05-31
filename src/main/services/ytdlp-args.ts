import { getSettings } from '@main/store/config'
import type { SiteProfile } from '@shared/settings'

/**
 * Split a CLI argument line into argv tokens, honoring single/double quotes so a
 * value with spaces (e.g. --add-header "Accept-Language: ja") stays one token.
 * Quotes group; whitespace separates; everything else is literal. Newlines count
 * as whitespace, so a multi-line global-args field works too.
 */
export function tokenizeArgs(line: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let inToken = false
  let quote: '"' | "'" | null = null
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (inToken) {
        tokens.push(cur)
        cur = ''
        inToken = false
      }
    } else {
      cur += ch
      inToken = true
    }
  }
  if (inToken) tokens.push(cur)
  return tokens
}

function matches(profile: SiteProfile, url: string): boolean {
  if (!profile.urlPattern) return false
  if (profile.isRegex) {
    try {
      return new RegExp(profile.urlPattern).test(url)
    } catch {
      return false // a malformed regex simply doesn't match
    }
  }
  return url.includes(profile.urlPattern)
}

/**
 * Extra yt-dlp args for a URL: the global args plus the first matching site
 * profile's args (profile last, so a site can extend the globals). The caller
 * places these BEFORE its own fixed flags, so the app's mechanics (output path,
 * info json, progress markers) always win on conflict.
 */
export function resolveYtdlpArgs(url: string): string[] {
  const settings = getSettings()
  const global = tokenizeArgs(settings.ytdlpArgs)
  const profile = settings.siteProfiles.find((p) => matches(p, url))
  return profile ? [...global, ...tokenizeArgs(profile.args)] : global
}
