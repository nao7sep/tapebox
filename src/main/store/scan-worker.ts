import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { SCAN_PAGE_SIZE, type ScanPage, type ScanResult } from '../../shared/ipc-contract.ts'

export type ScanRequest =
  | { op: 'append'; entry: ScanResult }
  | { op: 'page'; search: string; start: number }
  | { op: 'select'; selected: boolean; sourceUrl?: string; search?: string }
  | { op: 'selected'; after: number }
  | { op: 'close' }
export type SelectedPage = { entries: Array<{ sequence: number; url: string }>; count: number }
export type ScanValue = Omit<ScanPage, 'status'> | SelectedPage | null
export type ScanResponse = { id: number } & ({ ok: true; value: ScanValue } | { ok: false; error: string })

if (!parentPort) throw new Error('Scan store requires a parent port')
const port = parentPort
const db = new DatabaseSync((workerData as { path: string }).path)
// Disposable results have no restart contract; SQLite owns paging and selection
// without keeping a second result collection in either UI or main memory.
db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
  CREATE TABLE entries (sequence INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL, entry TEXT NOT NULL, eligible INTEGER NOT NULL,
    selected INTEGER NOT NULL, in_library INTEGER NOT NULL, unavailable INTEGER NOT NULL)`)
const append = db.prepare('INSERT OR IGNORE INTO entries(url,title,entry,eligible,selected,in_library,unavailable) VALUES(?,?,?,?,?,?,?)')
const counts = { total: 0, selected: 0, inLibrary: 0, unavailable: 0 }
const match = "instr(title, ?) > 0"
port.on('message', ({ id, request }: { id: number; request: ScanRequest }) => {
  try {
    let value: ScanValue = null
    if (request.op === 'append') {
      const e = request.entry
      const eligible = Number(!e.alreadyInLibrary && !e.unavailable)
      const inserted = append.run(e.sourceUrl, (e.title ?? '').toLowerCase(), JSON.stringify(e), eligible, eligible, Number(e.alreadyInLibrary), Number(!!e.unavailable)).changes
      if (inserted) {
        counts.total++; counts.selected += eligible
        counts.inLibrary += Number(e.alreadyInLibrary); counts.unavailable += Number(!!e.unavailable)
      }
    } else if (request.op === 'page') {
      const search = request.search.trim().toLowerCase()
      const matched = search ? (db.prepare(`SELECT count(*) AS matched FROM entries WHERE ${match}`).get(search) as { matched: number }).matched : counts.total
      const start = Math.min(request.start, Math.max(0, matched - 1))
      const rows = db.prepare(`SELECT entry, selected FROM entries WHERE ${match} ORDER BY sequence LIMIT ? OFFSET ?`).all(search, SCAN_PAGE_SIZE, start) as Array<{ entry: string; selected: number }>
      value = { ...counts, matched, start, entries: rows.map(row => ({ ...JSON.parse(row.entry) as ScanResult, selected: !!row.selected })) }
    } else if (request.op === 'select') {
      const changed = request.sourceUrl !== undefined
        ? db.prepare('UPDATE entries SET selected=? WHERE eligible=1 AND selected<>? AND url=?').run(Number(request.selected), Number(request.selected), request.sourceUrl).changes
        : db.prepare(`UPDATE entries SET selected=? WHERE eligible=1 AND selected<>? AND ${match}`).run(Number(request.selected), Number(request.selected), (request.search ?? '').trim().toLowerCase()).changes
      counts.selected += Number(changed) * (request.selected ? 1 : -1)
    } else if (request.op === 'selected') {
      const entries = db.prepare('SELECT sequence,url FROM entries WHERE selected=1 AND sequence>? ORDER BY sequence LIMIT ?').all(request.after, SCAN_PAGE_SIZE) as SelectedPage['entries']
      value = { count: counts.selected, entries }
    } else {
      db.close()
    }
    port.postMessage({ id, ok: true, value } satisfies ScanResponse)
    if (request.op === 'close') port.close()
  } catch (error) {
    port.postMessage({ id, ok: false, error: (error as Error).message } satisfies ScanResponse)
  }
})
