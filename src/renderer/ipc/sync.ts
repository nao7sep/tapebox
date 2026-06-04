import { ipcInvoke, ipcOn } from './client'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useBinariesStore } from '@renderer/store/binaries'
import { useRuntimeStore } from '@renderer/store/runtime'

/**
 * Wire renderer stores to main's IPC.
 *   - Initial pull: library:list, binaries:status, app:runtimeInfo.
 *   - Live: tapes:* + binaries:* events.
 * Returns a cleanup function for the caller's useEffect.
 */
export function startIpcSync(): () => void {
  void ipcInvoke('library:list').then((tapes) => useTapesStore.getState().setAll(tapes))
  void ipcInvoke('boxes:list').then((g) => useBoxesStore.getState().setBoxes(g))
  void ipcInvoke('binaries:status').then((s) => useBinariesStore.getState().setStatuses(s))
  void ipcInvoke('app:runtimeInfo').then((info) => useRuntimeStore.getState().setInfo(info))

  const offs = [
    ipcOn('tapes:added',       (tapes) => useTapesStore.getState().upsertMany(tapes)),
    ipcOn('tapes:updated',     (tape)  => useTapesStore.getState().upsert(tape)),
    ipcOn('tapes:updatedMany', (tapes) => useTapesStore.getState().upsertMany(tapes)),
    ipcOn('tapes:removed',     ({ tapeIds }) => useTapesStore.getState().removeMany(tapeIds)),
    ipcOn('boxes:changed',    (boxes) => useBoxesStore.getState().setBoxes(boxes)),
    ipcOn('tapes:progress',  ({ tapeId, phase, percent }) =>
      useTapesStore.getState().setProgress(tapeId, { phase, percent }),
    ),
    ipcOn('tapes:completed', ({ tapeId }) => useTapesStore.getState().clearProgress(tapeId)),
    ipcOn('tapes:failed',    ({ tapeId }) => useTapesStore.getState().clearProgress(tapeId)),

    ipcOn('binaries:progress', ({ name, percent, phase }) =>
      useBinariesStore.getState().setProgress(name, percent, phase),
    ),
    ipcOn('binaries:ready', ({ name, version }) =>
      useBinariesStore.getState().markReady(name, version),
    ),
  ]
  return () => offs.forEach((off) => off())
}
