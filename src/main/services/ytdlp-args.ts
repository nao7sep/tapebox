import { getSettings } from '@main/store/config'
import type { SiteProfile } from '@shared/settings'

/**
 * Split a CLI argument line into argv tokens. Single and double quotes group and
 * are stripped, so a spaced value stays one token in both the separated form
 * (--add-header "Accept-Language: ja") and the glued form
 * (--extractor-args="youtube:lang=ja"); whitespace separates, newlines included
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
 * yt-dlp flags derived from the preferred metadata language. Empty when unset.
 * We set only the general HTTP Accept-Language header — sites that honor it
 * return localized titles/metadata — and deliberately inject nothing
 * service-specific. A user who wants an extractor-specific knob (e.g. a
 * particular site's lang arg) adds it themselves via the global args or a site
 * profile.
 */
function languageArgs(language: string): string[] {
  const code = language.trim()
  if (!code) return []
  return ['--add-headers', `Accept-Language: ${code}`]
}

/**
 * Extra yt-dlp args for a URL, lowest precedence first: the language flags, then
 * the global args, then the first matching site profile's args. Later args win
 * on conflict, so an explicit profile overrides the globals, which override the
 * convenience language setting. The caller places this whole list BEFORE its own
 * fixed flags, so the app's mechanics (output path, info json, progress markers)
 * always win.
 */
export function resolveYtdlpArgs(url: string): string[] {
  const settings = getSettings()
  const language = languageArgs(settings.metadataLanguage)
  const global = tokenizeArgs(settings.ytdlpArgs)
  const profile = settings.siteProfiles.find((p) => matches(p, url))
  const extra = profile ? [...global, ...tokenizeArgs(profile.args)] : global
  return [...language, ...extra]
}
