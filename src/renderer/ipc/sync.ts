import { ipcInvoke, ipcOn } from './client'
import { useItemsStore } from '@renderer/store/items'
import { useGroupsStore } from '@renderer/store/groups'
import { useBinariesStore } from '@renderer/store/binaries'
import { useRuntimeStore } from '@renderer/store/runtime'

/**
 * Wire renderer stores to main's IPC.
 *   - Initial pull: library:list, binaries:status, app:runtimeInfo.
 *   - Live: items:* + binaries:* events.
 * Returns a cleanup function for the caller's useEffect.
 */
export function startIpcSync(): () => void {
  void ipcInvoke('library:list').then((items) => useItemsStore.getState().setAll(items))
  void ipcInvoke('archive:listGroups').then((g) => useGroupsStore.getState().setGroups(g))
  void ipcInvoke('binaries:status').then((s) => useBinariesStore.getState().setStatuses(s))
  void ipcInvoke('app:runtimeInfo').then((info) => useRuntimeStore.getState().setInfo(info))

  const offs = [
    ipcOn('items:added',       (items) => useItemsStore.getState().upsertMany(items)),
    ipcOn('items:updated',     (item)  => useItemsStore.getState().upsert(item)),
    ipcOn('items:updatedMany', (items) => useItemsStore.getState().upsertMany(items)),
    ipcOn('items:removed',     ({ itemIds }) => useItemsStore.getState().removeMany(itemIds)),
    ipcOn('groups:changed',    (groups) => useGroupsStore.getState().setGroups(groups)),
    ipcOn('items:progress',  ({ itemId, phase, percent }) =>
      useItemsStore.getState().setProgress(itemId, { phase, percent }),
    ),
    ipcOn('items:completed', ({ itemId }) => useItemsStore.getState().clearProgress(itemId)),
    ipcOn('items:failed',    ({ itemId }) => useItemsStore.getState().clearProgress(itemId)),

    ipcOn('binaries:progress', ({ name, percent, phase }) =>
      useBinariesStore.getState().setProgress(name, percent, phase),
    ),
    ipcOn('binaries:ready', ({ name, version }) =>
      useBinariesStore.getState().markReady(name, version),
    ),
  ]
  return () => offs.forEach((off) => off())
}
