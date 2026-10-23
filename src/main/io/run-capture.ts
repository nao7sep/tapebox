import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { collectRunFacts, type OutputChild } from './spawn'
import { createOutputMasker } from './stream-mask'
import { writeOutputChunk } from './records'

export const OUTPUT_CHUNK_UNITS = 32_768
const STDERR_TAIL_UNITS = 32_768

/** Discard the app's own progress echoes without buffering arbitrary lines. */
function withoutProgress(emit: (text: string) => void) {
  const marker = 'tapebox-progress:'
  let prefix = ''
  let mode: 'prefix' | 'keep' | 'drop' = 'prefix'
  return {
    feed(text: string) {
      let offset = 0
      while (offset < text.length) {
        if (mode === 'prefix') {
          const ch = text[offset++]!
          prefix += ch
          if (prefix === marker) { prefix = ''; mode = 'drop' }
          else if (!marker.startsWith(prefix)) {
            emit(prefix)
            prefix = ''
            mode = ch === '\n' ? 'prefix' : 'keep'
          }
        } else {
          const newline = text.indexOf('\n', offset)
          const end = newline < 0 ? text.length : newline + 1
          if (mode === 'keep') emit(text.slice(offset, end))
          offset = end
          if (newline >= 0) mode = 'prefix'
        }
      }
    },
    finish() { if (prefix) emit(prefix); prefix = '' },
  }
}

/** Full diagnostic output goes directly to bounded writer messages. Only the
 * JSON probe retains raw stdout; callers' error parsing keeps a small safe tail. */
export function createRunCapture(child: OutputChild, options: { credentials?: readonly string[]; rawStdout?: boolean; dropProgress?: boolean; onStderr?: (text: string) => void } = {}) {
  const facts = collectRunFacts(child)
  const outputKey = randomUUID()
  let rawStdout = ''
  let stderr = ''
  let finished = false
  const outputChunks = { stdout: 0, stderr: 0 }
  const pipes = (['stdout', 'stderr'] as const).map((stream) => {
    const decoder = new StringDecoder('utf8')
    let pending = ''
    const flush = () => {
      if (pending) writeOutputChunk(outputKey, stream, outputChunks[stream]++, pending)
      pending = ''
    }
    const safe = (text: string) => {
      if (stream === 'stderr') {
        options.onStderr?.(text)
        stderr = (stderr + text).slice(-STDERR_TAIL_UNITS)
        if (/^[\uDC00-\uDFFF]/.test(stderr)) stderr = stderr.slice(1)
      }
      let offset = 0
      while (offset < text.length) {
        let count = Math.min(OUTPUT_CHUNK_UNITS - pending.length, text.length - offset)
        if (offset + count < text.length && /[\uD800-\uDBFF]/.test(text[offset + count - 1]!)) count--
        if (count === 0) { flush(); continue }
        pending += text.slice(offset, offset + count)
        offset += count
        if (pending.length >= OUTPUT_CHUNK_UNITS - 1) flush()
      }
    }
    const masker = createOutputMasker(options.credentials ?? [], safe)
    const progress = options.dropProgress ? withoutProgress(masker.feed) : null
    const decoded = (text: string) => {
      if (stream === 'stdout' && options.rawStdout) rawStdout += text
      if (progress) progress.feed(text)
      else masker.feed(text)
    }
    child[stream].on('data', (chunk: Buffer | string) => decoded(typeof chunk === 'string' ? chunk : decoder.write(chunk)))
    return () => { decoded(decoder.end()); progress?.finish(); masker.finish(); flush() }
  })
  const finish = () => {
    if (finished) return
    finished = true
    for (const pipe of pipes) pipe()
  }
  child.once('close', finish)
  return { ...facts, outputKey, outputChunks, stdout: () => rawStdout, stderr: () => stderr, finish }
}
