import { Worker } from 'node:worker_threads'
import type { CatalogRequest, CatalogResponse } from './catalog-worker'

let worker: Worker | null = null
let nextId = 0
let idle: NodeJS.Timeout | undefined
const pending = new Map<number, { resolve: (value: CatalogResponse) => void; reject: (error: unknown) => void }>()

/** One codec, no mutable catalog mirror and no file writer. Idle retirement also
 * releases test/startup-only readers; in-flight requests retain the thread. */
export function catalogCodec(request: Omit<Extract<CatalogRequest, { op: 'encode' }>, 'id'> | Omit<Extract<CatalogRequest, { op: 'decode' }>, 'id'>): Promise<CatalogResponse> {
  clearTimeout(idle)
  if (!worker) {
    const created = new Worker(new URL(import.meta.url.endsWith('.ts') ? './catalog-worker.ts' : './catalog-worker.js', import.meta.url))
    worker = created
    const fail = (error: unknown): void => {
      if (worker !== created) return
      worker = null
      for (const item of pending.values()) item.reject(error)
      pending.clear()
      void created.terminate()
    }
    created.on('error', fail)
    created.on('exit', (code) => { if (worker === created) fail(new Error(`Catalog codec exited (${code})`)) })
    created.on('message', (response: CatalogResponse) => {
      const item = pending.get(response.id)
      if (!item) return
      pending.delete(response.id)
      item.resolve(response)
      if (pending.size === 0) {
        created.unref()
        idle = setTimeout(() => {
          if (worker === created && pending.size === 0) { worker = null; void created.terminate() }
        }, 1000)
        idle.unref()
      }
    })
  }
  const current = worker
  current.ref()
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try { current.postMessage({ ...request, id }) } catch (error) {
      pending.delete(id)
      if (pending.size === 0) { worker = null; void current.terminate() }
      reject(error)
    }
  })
}
