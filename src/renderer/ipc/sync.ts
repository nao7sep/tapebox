import { ipcInvoke, ipcOn } from './client'
import { useItemsStore } from '@renderer/store/items'

/**
 * Wire the renderer's stores to main's IPC.
 *   - Initial: fetch library:list once.
 *   - Live: subscribe to items:* events.
 * Returns a cleanup function for the caller's useEffect.
 */
export function startIpcSync(): () => void {
  const store = useItemsStore.getState()

  void ipcInvoke('library:list').then(store.setAll)

  const offs = [
    ipcOn('items:added', (items) => useItemsStore.getState().upsertMany(items)),
    ipcOn('items:updated', (item) => useItemsStore.getState().upsert(item)),
    ipcOn('items:removed', ({ itemIds }) => useItemsStore.getState().removeMany(itemIds)),
  ]
  return () => offs.forEach((off) => off())
}
