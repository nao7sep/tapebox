import { REDACTED } from './mask.ts'

const URL_END = /[\s"<>\\]/
const AUTHORITY_END = /[/\s?#"<>\\]/
const SIGNED_NAMES = ['signature', 'sig', 'lsig', 'pot']

/** Matches the existing diagnostic URL masking on decoded JSON string values.
 * Query secrets are discarded immediately. Only an unresolved authority needs
 * buffering: until @ or a delimiter, its text could still be user information. */
export class SidecarStringMask {
  private readonly query = new SignedQueryMask()
  private readonly credentials = new AuthorityMask()

  feed(chunk: string): string {
    return this.credentials.feed(this.query.feed(chunk))
  }

  end(): string {
    return this.credentials.end()
  }
}

class SignedQueryMask {
  private schemeTail = ''
  private inUrl = false
  private parameter: string | null = null
  private secret = false

  feed(chunk: string): string {
    let output = ''
    for (const char of chunk) {
      if (!this.inUrl) {
        output += char
        this.schemeTail = (this.schemeTail + char.toLowerCase()).slice(-8)
        if (this.schemeTail.endsWith('http://') || this.schemeTail === 'https://') {
          this.inUrl = true
          this.schemeTail = ''
        }
        continue
      }
      if (URL_END.test(char)) {
        this.inUrl = false
        this.secret = false
        this.parameter = null
        output += char
        continue
      }
      if (this.secret) {
        if (char === '&' || char === '#') {
          output += char
          this.secret = false
          this.parameter = char === '&' ? '' : null
        }
        continue
      }
      output += char
      if (char === '?' || char === '&') this.parameter = ''
      else if (this.parameter !== null) {
        if (char === '=' && SIGNED_NAMES.includes(this.parameter)) {
          output += REDACTED
          this.parameter = null
          this.secret = true
        } else {
          const next = this.parameter + char.toLowerCase()
          this.parameter = SIGNED_NAMES.some((name) => name.startsWith(next)) ? next : null
        }
      }
    }
    return output
  }
}

class AuthorityMask {
  private authority: string | null = null
  private scheme = false
  private slash = 0

  feed(chunk: string): string {
    let output = ''
    for (const char of chunk) {
      if (this.authority !== null) {
        if (char === '@') {
          output += (this.authority ? REDACTED : '') + '@'
          this.authority = null
        } else if (AUTHORITY_END.test(char)) {
          output += this.authority + char
          this.authority = null
        } else this.authority += char
      } else output += char

      // Scheme characters are emitted as they arrive. Tracking requires only a
      // flag and the two slashes, regardless of the scheme's length.
      if (char === '/' && this.slash) {
        if (this.slash === 2) {
          this.authority = ''
          this.slash = 0
        } else this.slash = 2
        this.scheme = false
      } else if (char === ':' && this.scheme) {
        this.slash = 1
        this.scheme = false
      } else {
        this.slash = 0
        if (/[a-z]/i.test(char)) this.scheme = true
        else if (!/[0-9+.-]/.test(char)) this.scheme = false
      }
    }
    return output
  }

  end(): string {
    const remainder = this.authority ?? ''
    this.authority = null
    return remainder
  }
}
