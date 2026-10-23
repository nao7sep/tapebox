import { Worker } from 'node:worker_threads'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScanRequest, ScanResponse, ScanValue, SelectedPage } from './scan-worker'
import type { ScanPage, ScanResult } from '@shared/ipc-contract'

/** Owns one temporary result file until both producer and consumer have settled. */
export async function createScanStore() {
  const directory = await mkdtemp(join(tmpdir(), 'tapebox-scan-'))
  let worker: Worker
  try {
    worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './scan-worker.ts' : './scan-worker.js', import.meta.url), { workerData: { path: join(directory, 'results.sqlite3') } })
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  let nextId = 0
  let failure: Error | undefined
  let closing: Promise<void> | undefined
  const pending = new Map<number, { resolve: (value: ScanValue) => void; reject: (error: Error) => void }>()
  const fail = (error: Error) => {
    failure = error
    for (const item of pending.values()) item.reject(error)
    pending.clear()
  }
  worker.on('error', fail)
  worker.on('exit', code => fail(new Error(`Scan store exited (${code})`)))
  worker.on('message', (response: ScanResponse) => {
    const item = pending.get(response.id)
    if (!item) return
    pending.delete(response.id)
    if (response.ok) item.resolve(response.value)
    else item.reject(new Error(response.error))
  })
  const request = (request: ScanRequest): Promise<ScanValue> => {
    if (failure) return Promise.reject(failure)
    return new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      try { worker.postMessage({ id, request }) } catch (error) { pending.delete(id); reject(error as Error) }
    })
  }
  return {
    append: async (entry: ScanResult): Promise<void> => { await request({ op: 'append', entry }) },
    page: (search: string, start: number) => request({ op: 'page', search, start }) as Promise<Omit<ScanPage, 'status'>>,
    select: async (selection: { selected: boolean; sourceUrl?: string; search?: string }): Promise<void> => { await request({ op: 'select', ...selection }) },
    selected: (after: number) => request({ op: 'selected', after }) as Promise<SelectedPage>,
    close: (): Promise<void> => closing ??= (async () => {
      try { if (!failure) await request({ op: 'close' }) }
      finally { await worker.terminate(); await rm(directory, { recursive: true, force: true }) }
    })(),
  }
}
export type ScanStore = Awaited<ReturnType<typeof createScanStore>>
