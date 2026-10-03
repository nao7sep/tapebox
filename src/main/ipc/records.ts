import { handle } from './handle'
import { currentSession } from '@main/io/records'
import { readRecords } from '@main/io/records-read'
import { openRecordsWindow } from '@main/records-window'
import * as session from '@main/store/session'

/**
 * The Records window: opening it, and its reads of records.sqlite3, which run on
 * the reader thread (io/records-read.ts). The filters' launches and tapes come
 * from the records themselves; a tape still in the library is named by its title.
 */
export function registerRecordsHandlers(): void {
  handle('records:open', () => openRecordsWindow())
  handle('records:page', (query) => readRecords({ op: 'page', query }))
  handle('records:detail', ({ kind, id }) => readRecords({ op: 'detail', kind, id }))
  handle('records:sources', async () => {
    const { sessions, tapeIds } = await readRecords({ op: 'sources' })
    const titles = new Map(session.getTapes().map((tape) => [tape.id, tape.title]))
    return {
      currentSession: currentSession(),
      sessions,
      tapes: tapeIds.map((tapeId) => ({ tapeId, name: titles.get(tapeId) ?? null })),
    }
  })
}
