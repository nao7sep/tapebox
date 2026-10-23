import { Worker } from 'node:worker_threads'
import type { SidecarRequest, SidecarResponse } from './sidecar-worker'
import type { SidecarProjection } from './sidecar-stream'
let worker: Worker | null = null
let nextId = 0
let idle: NodeJS.Timeout | undefined
const pending = new Map<number, { resolve: (value: SidecarProjection | null) => void; reject: (error: Error) => void; cleanup: () => void }>()

/** Paths and consumed fields cross this boundary; opaque documents stay on disk.
 * One worker serializes streaming transforms and retires when no caller owns it. */
export function sidecarCodec(request: SidecarRequest, signal?: AbortSignal): Promise<SidecarProjection | null> {
  signal?.throwIfAborted()
  clearTimeout(idle)
  if (!worker) {
    const created = new Worker(new URL(import.meta.url.endsWith('.ts') ? './sidecar-worker.ts' : './sidecar-worker.js', import.meta.url))
    worker = created
    const fail = (error: Error): void => {
      if (worker !== created) return
      worker = null
      for (const item of pending.values()) { item.cleanup(); item.reject(error) }
      pending.clear()
      void created.terminate()
    }
    created.on('error', fail)
    created.on('exit', code => fail(new Error(`Sidecar worker exited (${code})`)))
    created.on('message', (response: SidecarResponse) => {
      const item = pending.get(response.id)
      if (!item) return
      pending.delete(response.id)
      item.cleanup()
      if (response.ok) item.resolve(response.value)
      else item.reject(Object.assign(new Error(response.message), { name: response.name, code: response.code }))
      if (!pending.size) {
        created.unref()
        idle = setTimeout(() => { if (worker === created && !pending.size) { worker = null; void created.terminate() } }, 1000)
        idle.unref()
      }
    })
  }
  const current = worker
  current.ref()
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const cancel = () => current.postMessage({ cancel: id })
    const cleanup = () => signal?.removeEventListener('abort', cancel)
    pending.set(id, { resolve, reject, cleanup })
    signal?.addEventListener('abort', cancel, { once: true })
    try { current.postMessage({ id, request }) }
    catch (error) {
      pending.delete(id); cleanup()
      if (!pending.size) { worker = null; void current.terminate() }
      reject(error as Error)
    }
  })
}
