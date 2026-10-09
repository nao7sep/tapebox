/**
 * Credential masking for diagnostic copies (data-lifecycle conventions, credentials
 * in records): a credential value becomes `[REDACTED]` wherever a record, log
 * line or window event would hold it, while field names, nesting, an
 * authorization scheme such as `Bearer` and everything else stay as they were.
 * The owner that holds a credential masks its own copy before any sink receives
 * it; the live request or command is never touched. Pure: no I/O.
 */

export const REDACTED = '[REDACTED]'

/**
 * yt-dlp's YoutubeDL._calc_headers puts browser/file cookies in `cookies`
 * and request headers in `http_headers`, including nested formats. They are
 * not necessarily present in the arguments. Mask JSON string tokens without
 * parsing the output so a killed process's incomplete JSON is protected too.
 * Escaped quotes inside ordinary metadata strings are not property boundaries.
 * YouTube's extractor also emits signature and proof-of-origin URL parameters;
 * keep the URL and other parameters useful for diagnosing format selection.
 * This is a diagnostic copy only, never the info passed back to the caller.
 */
export function maskYtdlpOutput(text: string): string {
  const fields = text.replace(
    /(^|[,{]\s*)"(cookies|cookie|authorization|proxy-authorization)"(\s*:\s*)"((?:\\.|[^"\\])*)("|$)/gim,
    (_match, before: string, key: string, separator: string, value: string, end: string) => {
      const scheme = /authorization$/i.test(key) ? /^(Basic|Bearer|Digest|Token|Negotiate)\s+/i.exec(value)?.[0] ?? '' : ''
      return `${before}"${key}"${separator}"${scheme}${REDACTED}${end}`
    },
  )
  return fields.replace(/https?:\/\/[^\s"<>\\]+/gi, (url) => url.replace(
    /([?&](?:signature|sig|lsig|pot)=)[^&#]*/gi, `$1${REDACTED}`,
  ))
}

/**
 * Output is searched only for credentials at least this long: a shorter one
 * would also match ordinary text. Arguments are masked by position whatever
 * their length.
 */
const MIN_SEARCHED_LENGTH = 4

/** The user name and password in any `scheme://user:pass@` URL within `text`. */
export function maskUrlCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@?#]+@/gi, `$1${REDACTED}@`)
}

/**
 * A copy of `value` with every known credential and every URL login replaced in
 * each string, at any depth. Object keys are kept as they are.
 */
export function maskCredentials<T>(value: T, credentials: readonly string[]): T {
  const searched = [...new Set(credentials.filter((credential) => credential.length >= MIN_SEARCHED_LENGTH))]
    .sort((a, b) => b.length - a.length)
  const seen = new WeakMap<object, unknown>()
  const walk = (current: unknown): unknown => {
    if (typeof current === 'string') {
      let text = current
      for (const credential of searched) text = text.split(credential).join(REDACTED)
      return maskUrlCredentials(text)
    }
    if (current === null || typeof current !== 'object') return current
    if (seen.has(current)) return seen.get(current)
    if (Array.isArray(current)) {
      const copy: unknown[] = []
      seen.set(current, copy)
      for (const item of current) copy.push(walk(item))
      return copy
    }
    const copy: Record<string, unknown> = {}
    seen.set(current, copy)
    for (const [key, item] of Object.entries(current)) Object.defineProperty(copy, key, { value: walk(item), enumerable: true, writable: true, configurable: true })
    return copy
  }
  return walk(value) as T
}

/** yt-dlp options whose value is a secret. */
const SECRET_OPTIONS = new Set([
  '-p', '--password', '--video-password', '--ap-password', '-2', '--twofactor', '--client-certificate-password',
])
/** yt-dlp options whose value is a header line. */
const HEADER_OPTIONS = new Set(['--add-header', '--add-headers'])
/** Headers whose value is a credential; an authorization scheme word is kept. */
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie'])
const SCHEMES = new Set(['basic', 'bearer', 'digest', 'token', 'negotiate'])

function maskHeader(line: string, credentials: string[]): string {
  const colon = line.indexOf(':')
  if (colon < 0 || !SECRET_HEADERS.has(line.slice(0, colon).trim().toLowerCase())) return line
  const value = line.slice(colon + 1).trim()
  const [scheme, ...rest] = value.split(/\s+/)
  const keepScheme = rest.length > 0 && SCHEMES.has((scheme ?? '').toLowerCase())
  const secret = keepScheme ? rest.join(' ') : value
  if (secret) credentials.push(secret)
  return `${line.slice(0, colon + 1)} ${keepScheme ? `${scheme} ` : ''}${REDACTED}`
}

/**
 * A yt-dlp argument list as a record may hold it, and the credentials it carried
 * so their echoes in the run's output can be masked too: password options' values,
 * Authorization, Proxy-Authorization and Cookie header values, and URL logins
 * (a proxy's, for one). Both `--option value` and `--option=value` are read.
 */
export function maskYtdlpArgs(args: readonly string[]): { args: string[]; credentials: string[] } {
  const credentials: string[] = []
  const masked: string[] = []
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!
    const equals = token.startsWith('--') ? token.indexOf('=') : -1
    const option = equals > 0 ? token.slice(0, equals) : token
    const inline = equals > 0 ? token.slice(equals + 1) : null
    const glued = inline === null && /^-[p2].+/.test(token) ? token.slice(2) : null
    if (SECRET_OPTIONS.has(option) || glued !== null) {
      const name = glued !== null ? token.slice(0, 2) : option
      const value = glued ?? inline ?? args[index + 1]
      if (value !== undefined) credentials.push(value)
      if (glued !== null) masked.push(`${name}${REDACTED}`)
      else if (inline !== null) masked.push(`${option}=${REDACTED}`)
      else { masked.push(token); if (value !== undefined) { masked.push(REDACTED); index += 1 } }
      continue
    }
    if (HEADER_OPTIONS.has(option)) {
      if (inline !== null) masked.push(`${option}=${maskHeader(inline, credentials)}`)
      else {
        masked.push(token)
        const value = args[index + 1]
        if (value !== undefined) { masked.push(maskHeader(value, credentials)); index += 1 }
      }
      continue
    }
    masked.push(maskUrlCredentials(token))
  }
  for (const token of args) {
    const login = /[a-z][a-z0-9+.-]*:\/\/([^/\s@?#]+)@/i.exec(token)?.[1]
    if (login) credentials.push(login)
  }
  return { args: masked, credentials }
}
