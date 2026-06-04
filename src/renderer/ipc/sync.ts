import { ipcInvoke, ipcOn } from './client'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useBinariesStore } from '@renderer/store/binaries'
import { useRuntimeStore } from '@renderer/store/runtime'
import { useDownloadLogStore } from '@renderer/store/downloadLog'

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
    ipcOn('tapes:removed',     ({ tapeIds }) => {
      useTapesStore.getState().removeMany(tapeIds)
      tapeIds.forEach((id) => useDownloadLogStore.getState().reset(id))
    }),
    ipcOn('boxes:changed',    (boxes) => useBoxesStore.getState().setBoxes(boxes)),
    ipcOn('tapes:progress',  ({ tapeId, phase, percent, speedBps, etaSec }) =>
      useTapesStore.getState().setProgress(tapeId, { phase, percent, speedBps, etaSec }),
    ),
    ipcOn('tapes:completed', ({ tapeId }) => {
      useTapesStore.getState().clearProgress(tapeId)
      // Success: the player takes over, so the live log is no longer needed.
      useDownloadLogStore.getState().reset(tapeId)
    }),
    ipcOn('tapes:failed',    ({ tapeId, error }) => {
      useTapesStore.getState().clearProgress(tapeId)
      // The error caps the log as its newest (top) entry.
      useDownloadLogStore.getState().prepend(tapeId, { kind: 'error', text: error })
    }),
    ipcOn('tapes:log',       ({ tapeId, line }) =>
      useDownloadLogStore.getState().prepend(tapeId, { kind: 'line', text: line }),
    ),
    ipcOn('tapes:logReset',  ({ tapeId }) => useDownloadLogStore.getState().reset(tapeId)),

    ipcOn('binaries:progress', ({ name, percent, phase }) =>
      useBinariesStore.getState().setProgress(name, percent, phase),
    ),
    ipcOn('binaries:ready', ({ name, version }) =>
      useBinariesStore.getState().markReady(name, version),
    ),
  ]
  return () => offs.forEach((off) => off())
}
