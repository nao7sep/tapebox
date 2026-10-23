/** Incremental diagnostic masking. JSON credential values are discarded as they
 * arrive, and known secret matches retain only the longest possible suffix.
 * Unlike a line buffer, an ordinary long JSON string never retains its contents. */
export function createOutputMasker(credentials: readonly string[], emit: (text: string) => void): {
  feed(text: string): void
  finish(): void
} {
  const redacted = '[REDACTED]'
  const secrets = [...new Set(credentials.filter((value) => value.length >= 4))].sort((a, b) => b.length - a.length)
  const longest = Math.max(1, ...secrets.map((value) => value.length))
  let pending = ''
  let output = ''
  const write = (text: string) => {
    output += text
    if (output.length >= 8192) { emit(output); output = '' }
  }

  // The scheme has already been emitted when its authority starts. Retain only
  // the ambiguous authority until @ or its terminating delimiter establishes
  // whether it contains a login; paths and ordinary text stream immediately.
  let schemeTail = ''
  let url: 'none' | 'authority' | 'path' | 'key' | 'secret' = 'none'
  let authority = ''
  let queryKey = ''
  const delimiter = (char: string) => /[\s"<>\\]/.test(char)
  const flushAuthority = () => {
    const at = authority.lastIndexOf('@')
    write(at < 0 ? authority : redacted + authority.slice(at))
    authority = ''
  }
  const urlChar = (char: string): void => {
    if (url === 'authority') {
      if (!delimiter(char) && char !== '/' && char !== '?' && char !== '#') { authority += char; return }
      flushAuthority(); url = 'path'
    }
    if (url === 'secret') {
      if (!delimiter(char) && char !== '&' && char !== '#') return
      url = 'path'
    }
    if (url === 'key') {
      if (char === '=') {
        write(queryKey + '=')
        const secret = /^(?:signature|sig|lsig|pot)$/i.test(queryKey)
        queryKey = ''; url = secret ? 'secret' : 'path'
        if (secret) write(redacted)
        return
      }
      if (!delimiter(char) && char !== '&' && char !== '#' && queryKey.length < 9) { queryKey += char; return }
      write(queryKey); queryKey = ''; url = 'path'
    }
    if (url === 'path') {
      if (delimiter(char)) url = 'none'
      else if (char === '?' || char === '&') { write(char); url = 'key'; return }
    }
    write(char)
    if (url === 'none') {
      schemeTail = (schemeTail + char).slice(-3)
      if (schemeTail === '://') { url = 'authority'; schemeTail = '' }
    }
  }
  const safe = (text: string) => { for (const char of text) urlChar(char) }

  let state: 'plain' | 'key' | 'string' | 'afterKey' | 'beforeSecret' | 'secret' = 'plain'
  let wantsKey = false
  let escaped = false
  let key = ''
  let authorization = false
  let scheme = ''
  let valueMarked = false
  const markValue = () => {
    if (valueMarked) return
    safe(redacted); valueMarked = true; scheme = ''
  }
  const jsonChar = (char: string): void => {
    if (state === 'secret') {
      if (!escaped && char === '"') {
        markValue(); safe(char); state = 'plain'; wantsKey = false
        return
      }
      if (!valueMarked) {
        // Authorization schemes remain readable, without buffering the value.
        if (authorization && !escaped && /\s/.test(char) && /^(Basic|Bearer|Digest|Token|Negotiate)$/i.test(scheme)) {
          safe(scheme + char); markValue()
        } else if (authorization && !escaped && /[A-Za-z]/.test(char) && scheme.length < 9) scheme += char
        else markValue()
      }
      escaped = !escaped && char === '\\'
      return
    }
    if (state === 'key') {
      safe(char)
      if (!escaped && char === '"') {
        authorization = /^(authorization|proxy-authorization)$/i.test(key)
        state = authorization || /^(cookies|cookie)$/i.test(key) ? 'afterKey' : 'plain'
        wantsKey = false; key = ''; return
      }
      key += char
      if (key.length > 19 || escaped) { state = 'string'; key = '' }
      escaped = !escaped && char === '\\'
      return
    }
    if (state === 'string') {
      safe(char)
      if (!escaped && char === '"') { state = 'plain'; wantsKey = false }
      escaped = !escaped && char === '\\'
      return
    }
    if (state === 'afterKey') {
      if (/\s/.test(char)) { safe(char); return }
      if (char === ':') { safe(char); state = 'beforeSecret'; return }
      state = 'plain'
    }
    if (state === 'beforeSecret') {
      if (/\s/.test(char)) { safe(char); return }
      if (char === '"') {
        safe(char); state = 'secret'; escaped = false; scheme = ''; valueMarked = false
        return
      }
      state = 'plain'
    }
    safe(char)
    if (char === '"') { state = wantsKey ? 'key' : 'string'; escaped = false; key = '' }
    else if (char === '{' || char === ',') wantsKey = true
    else if (!/\s/.test(char)) wantsKey = false
  }
  const drain = (final: boolean) => {
    let index = 0
    const end = final ? pending.length : Math.max(0, pending.length - longest + 1)
    while (index < end) {
      const secret = secrets.find((value) => pending.startsWith(value, index))
      if (secret) {
        for (const char of redacted) jsonChar(char)
        index += secret.length
      } else {
        // Preserve surrogate pairs when a text chunk ends between their halves.
        const point = pending.codePointAt(index)!
        if (!final && point >= 0xd800 && point <= 0xdbff && index + 1 === pending.length) break
        const char = String.fromCodePoint(point)
        jsonChar(char); index += char.length
      }
    }
    pending = pending.slice(index)
  }
  return {
    feed(text) { pending += text; drain(false); if (output) { emit(output); output = '' } },
    finish() {
      drain(true)
      if (state === 'secret') markValue()
      if (url === 'authority') flushAuthority()
      if (url === 'key') write(queryKey)
      if (output) { emit(output); output = '' }
    },
  }
}
