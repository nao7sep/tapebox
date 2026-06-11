import { getSettings } from '@main/store/config'
import type { SiteProfile } from '@shared/settings'

/**
 * Split a CLI argument line into argv tokens. Single and double quotes group and
 * are stripped, so a spaced value stays one token in both the separated form
 * (--add-header "Accept-Language: ja") and the glued form
 * (--extractor-args="site:lang=ja"); whitespace separates, newlines included
 * so the multi-line global-args field works; every other character — backslash
 * included — is literal.
 *
 * Deliberately hand-rolled, not a package: the requirement diverges from POSIX
 * shell word-splitting. These args run on Windows, where a path such as
 * --ffmpeg-location C:\tools\bin carries backslashes; POSIX splitters (shlex)
 * read '\' as an escape and corrupt the path, while string-argv leaves the
 * quotes in the glued --flag="x" form — both measured worse than this here. The
 * sole thing it can't do is embed a literal quote inside a value, a non-need for
 * yt-dlp. Tokens go to the child via spawn (no shell), so globs, $vars and
 * operators are never expanded.
 */
function tokenizeArgs(line: string): string[] {
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
 * Extra yt-dlp args for a URL, lowest precedence first: the global args, then the
 * first matching site profile's args. Later args win on conflict, so an explicit
 * profile overrides the globals. The caller places this whole list BEFORE its own
 * fixed flags, so the app's mechanics (output path, info json, progress markers)
 * always win.
 */
export function resolveYtdlpArgs(url: string): string[] {
  const settings = getSettings()
  const global = tokenizeArgs(settings.ytdlpArgs)
  const profile = settings.siteProfiles.find((p) => matches(p, url))
  return profile ? [...global, ...tokenizeArgs(profile.args)] : global
}
