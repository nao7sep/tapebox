import { open } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import parser, { type Token } from 'stream-json/parser.js'
import stringer from 'stream-json/stringer.js'
import Assembler from 'stream-json/assembler.js'
import { sidecarRevision as stampOf, assertSidecarRevision } from './sidecar-revision.ts'
import { SidecarStringMask } from './sidecar-string-mask.ts'

export type SidecarRewrite = {
  root?: Record<string, unknown>
  tapebox?: Record<string, unknown>
  stripPaths?: boolean
  mask?: boolean
}
export type SidecarReadMode = 'preview' | 'catalog' | 'metadata' | 'description' | 'version'
export type SidecarProjection = { value: unknown; stamp: string; chapterCount: number | null }
const rootFields = new Set(['formatVersion', 'id', 'extractor', 'title', 'uploader', 'duration', 'description', 'ext', 'vcodec', 'acodec', 'width', 'height', 'fps', 'filesize', 'filesize_approx'])
const boxFields = new Set(['sourceUrl', 'name', 'addedAtUtc', 'downloadedAtUtc', 'renamedAtUtc', 'mediaFilename', 'thumbnailFilename'])
const mediaFields = new Set(['vcodec', 'acodec', 'width', 'height', 'fps', 'durationSeconds'])
const chapterFields = new Set(['title', 'start_time', 'end_time'])
const stripped = new Set(['filename', '_filename', 'filepath', '_filepath', '__finaldir', '__files_to_move', 'requested_downloads'])

/** Only consumed fields are materialized. Opaque strings, arrays and objects are
 * still parsed completely, but pass through without becoming an object graph. */
export async function projectSidecar(path: string, signal?: AbortSignal, mode: SidecarReadMode = 'preview'): Promise<SidecarProjection> {
  const file = await open(path, 'r')
  try {
    const before = stampOf(await file.stat({ bigint: true }))
    const asm = new Assembler()
    let text = ''
    const chapters = { count: null as number | null }
    await pipeline(file.createReadStream({ autoClose: false }), parser.asStream({ packStrings: false, streamKeys: false, streamNumbers: false }), source => countChapters(source, chapters), source => projectTokens(source, mode), async source => {
      for await (const item of source) {
        const token = item as Token
        if (token.name === 'startString') text = ''
        else if (token.name === 'stringChunk') text += token.value
        else if (token.name === 'endString') { asm.consume({ name: 'stringValue', value: text }); text = '' }
        else asm.consume(token)
      }
    }, { signal })
    if (before !== stampOf(await file.stat({ bigint: true }))) throw new Error('Sidecar changed while being read')
    await assertSidecarRevision(path, before)
    return { value: asm.current, stamp: before, chapterCount: chapters.count }
  } finally { await file.close() }
}

/** Emit the selected shape directly. Keeping actual container tokens preserves
 * duplicate-property last-value semantics even for empty or invalid containers. */
async function* projectTokens(source: AsyncIterable<Token>, mode: SidecarReadMode): AsyncIterable<Token> {
  const stack: Frame[] = []
  let scalar = false
  const path = (): Array<string | number> => {
    const p = stack.at(-1)
    return p ? [...p.path, p.type === 'array' ? p.index : p.key] : []
  }
  const selected = (path: Array<string | number>): boolean => {
    if (stack.at(-1)?.skip) return false
    if (!path.length) return true
    if (mode === 'version') return path.length === 1 && path[0] === 'formatVersion'
    if (mode === 'description') return path.length === 1 && (path[0] === 'formatVersion' || path[0] === 'description')
    if (mode === 'catalog' && path[0] === 'description') return false
    if (path[0] === 'chapters' && path.length > 1 && mode !== 'preview') return false
    if (path.length === 1) return rootFields.has(String(path[0])) || path[0] === 'tapebox' || path[0] === 'chapters'
    if (path[0] === 'tapebox') return path.length === 2 && (boxFields.has(String(path[1])) || path[1] === 'media') || path.length === 3 && path[1] === 'media' && mediaFields.has(String(path[2]))
    return path[0] === 'chapters' && (path.length === 2 || path.length === 3 && chapterFields.has(String(path[2])))
  }
  const finish = (): void => { const p = stack.at(-1); if (p?.type === 'array') p.index++ }
  for await (const token of source) {
    if (token.name === 'keyValue') {
      stack.at(-1)!.key = token.value
      if (selected(path())) yield token
    } else if (token.name === 'startObject' || token.name === 'startArray') {
      const current = path()
      const skip = !selected(current)
      stack.push({ type: token.name === 'startObject' ? 'object' : 'array', path: current, key: '', index: 0, skip })
      if (!skip) yield token
    } else if (token.name === 'endObject' || token.name === 'endArray') {
      if (!stack.pop()!.skip) yield token
      finish()
    } else if (token.name === 'startString') {
      scalar = selected(path())
      if (scalar) yield token
    } else if (token.name === 'stringChunk') {
      if (scalar) yield token
    } else if (token.name === 'endString') {
      if (scalar) yield token
      finish()
    } else {
      if (selected(path())) yield token
      finish()
    }
  }
}

/** Count chapter entries without retaining their titles during catalog reads. */
async function* countChapters(source: AsyncIterable<Token>, result: { count: number | null }): AsyncIterable<Token> {
  let depth = 0
  let key = ''
  let active = false
  for await (const token of source) {
    if (token.name === 'keyValue' && depth === 1) key = token.value
    const container = token.name === 'startObject' || token.name === 'startArray'
    const scalar = token.name === 'startString' || token.name === 'numberValue' || token.name === 'nullValue' || token.name === 'trueValue' || token.name === 'falseValue'
    if (container || scalar) {
      if (depth === 1 && key === 'chapters') {
        active = token.name === 'startArray'
        result.count = active ? 0 : null
      } else if (depth === 2 && active) result.count!++
    }
    if (container) depth++
    else if (token.name === 'endObject' || token.name === 'endArray') {
      depth--
      if (depth === 1) active = false
    }
    yield token
  }
}

/** Streams a complete replacement into an already owned stage. Publication and
 * durability stay with the existing atomic-file owner in main. */
export async function rewriteSidecarStage(path: string, output: string, patch: SidecarRewrite, version: number, expectedStamp?: string, signal?: AbortSignal): Promise<void> {
  const file = await open(path, 'r')
  try {
    const before = stampOf(await file.stat({ bigint: true }))
    if (expectedStamp !== undefined && expectedStamp !== before) throw new Error('Sidecar changed before it could be rewritten')
    await pipeline(file.createReadStream({ autoClose: false }), parser.asStream({ packStrings: false, streamKeys: false, streamNumbers: false }), source => rewriteTokens(source, patch, version), source => patch.mask ? maskTokens(source) : source, stringer.asStream({ useKeyValues: true, useNumberValues: true }), async function* (source) { for await (const chunk of source) yield chunk; yield '\n' }, createWriteStream(output), { signal })
    if (before !== stampOf(await file.stat({ bigint: true }))) throw new Error('Sidecar changed while being rewritten')
    await assertSidecarRevision(path, before)
  } finally { await file.close() }
}

type Frame = { type: 'object' | 'array'; path: Array<string | number>; key: string; index: number; skip: boolean }
async function* rewriteTokens(source: AsyncIterable<Token>, patch: SidecarRewrite, version: number): AsyncIterable<Token> {
  const stack: Frame[] = []
  const root = { ...patch.root, formatVersion: version }
  let skipScalar = false
  let boxSeen = false
  const valuePath = (): Array<string | number> => {
    const parent = stack.at(-1)
    return parent ? [...parent.path, parent.type === 'array' ? parent.index : parent.key] : []
  }
  const finish = (): void => { const p = stack.at(-1); if (p?.type === 'array') p.index++ }
  const shouldSkip = (path: Array<string | number>): boolean => {
    if (stack.at(-1)?.skip) return true
    if (path.length === 1 && (Object.hasOwn(root, path[0]!) || patch.stripPaths && stripped.has(String(path[0])))) return true
    if (path.length === 2 && path[0] === 'tapebox' && patch.tapebox && Object.hasOwn(patch.tapebox, path[1]!)) return true
    return !!(patch.stripPaths && path.length === 3 && typeof path[1] === 'number' && ['formats', 'requested_formats'].includes(String(path[0])) && path[2] === 'filepath')
  }
  for await (const token of source) {
    if (token.name === 'keyValue') {
      stack.at(-1)!.key = token.value
      if (!shouldSkip(valuePath())) yield token
      continue
    }
    if (token.name === 'startObject' || token.name === 'startArray') {
      const path = valuePath()
      if (!stack.length && token.name !== 'startObject') throw new Error('the root is not a JSON object')
      const skip = shouldSkip(path)
      if (path.length === 1 && path[0] === 'tapebox' && token.name === 'startObject') boxSeen = true
      stack.push({ type: token.name === 'startObject' ? 'object' : 'array', path, key: '', index: 0, skip })
      if (!skip) {
        yield token
        if (path.length === 0) { yield { name: 'keyValue', value: 'formatVersion' }; yield { name: 'numberValue', value: String(version) } }
      }
      continue
    }
    if (token.name === 'endObject' || token.name === 'endArray') {
      const frame = stack.pop()!
      if (!frame.skip) {
        if (frame.path.length === 1 && frame.path[0] === 'tapebox' && frame.type === 'object' && patch.tapebox) yield* properties(patch.tapebox)
        if (!frame.path.length) {
          const { formatVersion: _version, ...fields } = root
          yield* properties(fields)
          if (patch.tapebox && !boxSeen && !Object.hasOwn(root, 'tapebox')) { yield { name: 'keyValue', value: 'tapebox' }; yield* valueTokens(patch.tapebox) }
        }
        yield token
      }
      finish()
      continue
    }
    if (token.name === 'startString') {
      if (!stack.length) throw new Error('the root is not a JSON object')
      skipScalar = shouldSkip(valuePath())
      if (!skipScalar) yield token
    } else if (token.name === 'stringChunk') {
      if (!skipScalar) yield token
    } else if (token.name === 'endString') {
      if (!skipScalar) yield token
      finish()
    } else {
      if (!stack.length) throw new Error('the root is not a JSON object')
      if (!shouldSkip(valuePath())) yield token
      finish()
    }
  }
}
function* properties(value: Record<string, unknown>): Iterable<Token> {
  for (const [key, item] of Object.entries(value)) { yield { name: 'keyValue', value: key }; yield* valueTokens(item) }
}
function* valueTokens(value: unknown): Iterable<Token> {
  if (value === null) yield { name: 'nullValue', value: null }
  else if (typeof value === 'string') { yield { name: 'startString' }; yield { name: 'stringChunk', value }; yield { name: 'endString' } }
  else if (typeof value === 'number') yield { name: 'numberValue', value: String(value) }
  else if (typeof value === 'boolean') yield value ? { name: 'trueValue', value: true } : { name: 'falseValue', value: false }
  else if (Array.isArray(value)) { yield { name: 'startArray' }; for (const item of value) yield* valueTokens(item); yield { name: 'endArray' } }
  else if (value && typeof value === 'object') { yield { name: 'startObject' }; yield* properties(value as Record<string, unknown>); yield { name: 'endObject' } }
  else throw new Error('Unsupported sidecar patch value')
}

/** Mask the final token stream, including newly inserted managed fields. */
async function* maskTokens(source: AsyncIterable<Token>): AsyncIterable<Token> {
  let key = ''
  let mask: SidecarStringMask | undefined
  let secret = false
  let auth = false
  let prefix = ''
  let wroteSecret = false
  for await (const token of source) {
    if (token.name === 'keyValue') {
      key = token.value
      const keyMask = new SidecarStringMask()
      yield { name: 'keyValue', value: keyMask.feed(key) + keyMask.end() }
    }
    else if (token.name === 'startString') {
      secret = /^(cookies|cookie|authorization|proxy-authorization)$/i.test(key)
      auth = /authorization$/i.test(key)
      prefix = ''; wroteSecret = false
      mask = secret ? undefined : new SidecarStringMask()
      yield token
    } else if (token.name === 'stringChunk') {
      if (secret) {
        if (!wroteSecret) {
          prefix += token.value
          const scheme = /^(Basic|Bearer|Digest|Token|Negotiate)\s+/i.exec(prefix)?.[0]
          const possible = ['basic', 'bearer', 'digest', 'token', 'negotiate'].some(s => s.startsWith(prefix.toLowerCase()))
          if (!auth || scheme || !possible) {
            yield { name: 'stringChunk', value: (auth ? scheme ?? '' : '') + '[REDACTED]' }
            wroteSecret = true; prefix = ''
          }
        }
      } else yield { name: 'stringChunk', value: mask!.feed(token.value) }
    } else if (token.name === 'endString') {
      if (secret && !wroteSecret) yield { name: 'stringChunk', value: '[REDACTED]' }
      if (mask) yield { name: 'stringChunk', value: mask.end() }
      yield token
      key = ''
    } else { key = ''; yield token }
  }
}
