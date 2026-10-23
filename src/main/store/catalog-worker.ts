import { parentPort } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { SessionSchema, type Session } from '../../shared/domain.ts'
import { FORMAT_VERSIONS, parseStoreJson, withFormatVersion } from '../io/format-version.ts'

export type CatalogRequest = { id: number } & ({ op: 'encode'; session: Session } | { op: 'decode'; path: string })
export type CatalogResponse = { id: number } & (
  { kind: 'encoded'; bytes: Uint8Array } | { kind: 'decoded'; session: Session; bytes: Uint8Array } |
  { kind: 'newer'; version: number } | { kind: 'invalid'; detail: string } |
  { kind: 'error'; detail: string; code?: string }
)
if (!parentPort) throw new Error('Catalog codec requires a parent port')
const port = parentPort
port.on('message', (request: CatalogRequest) => {
  try {
    if (request.op === 'encode') {
      // Live mutations have already been admitted. Only the durable projection
      // and one encoding belong here; loading still validates the whole input.
      const bytes = encode(request.session)
      port.postMessage({ id: request.id, kind: 'encoded', bytes } satisfies CatalogResponse, [bytes.buffer])
    } else {
      const found = parseStoreJson(readFileSync(request.path, 'utf8'), FORMAT_VERSIONS.catalog)
      if (found.status === 'newer') port.postMessage({ id: request.id, kind: 'newer', version: found.version } satisfies CatalogResponse)
      else {
        const parsed = found.status === 'read' ? SessionSchema.safeParse(found.value) : null
        port.postMessage(parsed?.success
          ? { id: request.id, kind: 'decoded', session: parsed.data, bytes: encode(parsed.data) } satisfies CatalogResponse
          : { id: request.id, kind: 'invalid', detail: found.status === 'unreadable' ? found.error.message : String(parsed?.error) } satisfies CatalogResponse)
      }
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    port.postMessage({ id: request.id, kind: 'error', detail: err.message, code: err.code } satisfies CatalogResponse)
  }
})

function encode(session: Session): Uint8Array<ArrayBuffer> {
  const tapes = session.tapes.map((tape) => ['probing', 'ready', 'downloading'].includes(tape.state)
    ? { ...tape, state: 'queued', downloadStartedAtUtc: null } : tape)
  return new TextEncoder().encode(JSON.stringify(withFormatVersion({ tapes, boxes: session.boxes }, FORMAT_VERSIONS.catalog), null, 2) + '\n')
}
