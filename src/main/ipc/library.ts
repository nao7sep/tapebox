import { handle } from './handle'
import { emit } from './events'
import * as session from '@main/store/session'
import { nowUtcIso } from '@shared/utc'

export function registerLibraryHandlers(): void {
  handle('library:list', async () => session.getItems())

  handle('library:archive', async ({ itemIds }) => {
    const at = nowUtcIso()
    for (const id of itemIds) {
      const item = session.getItem(id)
      if (!item || item.archivedAtUtc) continue
      const updated = { ...item, archivedAtUtc: at }
      session.upsertItem(updated)
      emit('items:updated', updated)
    }
  })

  handle('library:unarchive', async ({ itemIds }) => {
    for (const id of itemIds) {
      const item = session.getItem(id)
      if (!item || !item.archivedAtUtc) continue
      const updated = { ...item, archivedAtUtc: null }
      session.upsertItem(updated)
      emit('items:updated', updated)
    }
  })
}
