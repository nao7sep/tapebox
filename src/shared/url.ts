/**
 * URL helpers shared across processes.
 */

/**
 * Return `raw` with any userinfo — the `user:password@` segment before the host —
 * removed, so a URL written to a log can never carry an embedded credential.
 *
 * This closes a blind spot the name-based log redactor cannot: that redactor
 * matches denied field *names* and never scans string *values*, so a secret
 * living inside a URL string (an API key in `https://key@host/v1`, or basic auth
 * in `https://user:pass@host/video`) would otherwise reach disk verbatim.
 *
 * Total and non-throwing — safe to call on any value already bound for a log
 * line: a string that does not parse as a URL has no userinfo to strip and is
 * returned unchanged; a URL without userinfo is returned byte-identical (no
 * normalization). Only a URL that actually carries credentials is rewritten, to
 * the same URL with the userinfo dropped.
 */
export function stripUrlCredentials(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return raw
  }
  if (!parsed.username && !parsed.password) return raw
  parsed.username = ''
  parsed.password = ''
  return parsed.toString()
}

/**
 * Parse `raw` as an importable media URL — a syntactically valid http(s) URL —
 * returning the parsed URL, or null for anything else (file:, internal schemes,
 * garbage). This is the single gate every renderer-supplied URL must cross before
 * it reaches yt-dlp, so a non-web scheme can't drive the downloader at local files
 * or internal endpoints.
 */
export function parseImportableUrl(raw: string): URL | null {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
}

/** True when `raw` is a syntactically valid http(s) URL. See parseImportableUrl. */
export function isImportableUrl(raw: string): boolean {
  return parseImportableUrl(raw) !== null
}
