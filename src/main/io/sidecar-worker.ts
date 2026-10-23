import { parentPort } from 'node:worker_threads'
import { projectSidecar, rewriteSidecarStage, type SidecarProjection, type SidecarRewrite, type SidecarReadMode } from './sidecar-stream.ts'
export type SidecarRequest = { op: 'read'; path: string; mode?: SidecarReadMode } | { op: 'rewrite'; path: string; output: string; patch: SidecarRewrite; version: number; expectedStamp?: string }
export type SidecarResponse = { id: number } & ({ ok: true; value: SidecarProjection | null } | { ok: false; message: string; name: string; code?: string })
if (!parentPort) throw new Error('Sidecar worker requires a parent port')
const port = parentPort
const controllers = new Map<number, AbortController>()
let tail = Promise.resolve()
port.on('message', (message: { id: number; request: SidecarRequest } | { cancel: number }) => {
  if ('cancel' in message) { controllers.get(message.cancel)?.abort(); return }
  const { id, request } = message
  const ctl = new AbortController()
  controllers.set(id, ctl)
  tail = tail.then(async () => {
    try {
      ctl.signal.throwIfAborted()
      let value: SidecarProjection | null = null
      if (request.op === 'read') value = await projectSidecar(request.path, ctl.signal, request.mode)
      else await rewriteSidecarStage(request.path, request.output, request.patch, request.version, request.expectedStamp, ctl.signal)
      port.postMessage({ id, ok: true, value } satisfies SidecarResponse)
    } catch (error) {
      const e = error as NodeJS.ErrnoException
      port.postMessage({ id, ok: false, name: e.name, message: e.message, code: e.code } satisfies SidecarResponse)
    } finally { controllers.delete(id) }
  })
})
