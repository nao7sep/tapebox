import { ipcInvoke, ipcOn } from './client'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useBinariesStore } from '@renderer/store/binaries'
import { useRuntimeStore } from '@renderer/store/runtime'
import { useDownloadLogStore } from '@renderer/store/downloadLog'
import { downloadFailurePresentation } from '@renderer/lib/downloadFailure'
import { useMediaStore } from '@renderer/store/media'
import { useLayoutStore } from '@renderer/store/layout'
import { useSettingsStore } from '@renderer/store/settings'
import type { Tape, Box } from '@shared/domain'
import type { BinaryStatus, RuntimeInfo } from '@shared/ipc-contract'
import type { Layout } from '@shared/layout'
import type { Settings } from '@shared/settings'
import { useTapeActionResultsStore } from '@renderer/store/tapeActionResults'

export type InitialSyncState = {
  tapes: Tape[]
  boxes: Box[]
  binaries: BinaryStatus[]
  runtime: RuntimeInfo
  mediaBaseUrl: string
  layout: Layout
  settings: Settings
}

/** Pull every required renderer mirror without publishing partial snapshots. */
export async function pullInitialSyncState(): Promise<InitialSyncState> {
  const [tapes, boxes, binaries, runtime, media, layout, settings] = await Promise.all([
    ipcInvoke('library:list'),
    ipcInvoke('boxes:list'),
    ipcInvoke('binaries:status'),
    ipcInvoke('app:runtimeInfo'),
    ipcInvoke('media:endpoint'),
    ipcInvoke('layout:get'),
    ipcInvoke('settings:get'),
  ])
  return { tapes, boxes, binaries, runtime, mediaBaseUrl: media.baseUrl, layout, settings }
}

export function applyInitialSyncState(state: InitialSyncState): void {
  useTapesStore.getState().setAll(state.tapes)
  useBoxesStore.getState().setBoxes(state.boxes)
  useBinariesStore.getState().setStatuses(state.binaries)
  useRuntimeStore.getState().setInfo(state.runtime)
  useMediaStore.getState().setBaseUrl(state.mediaBaseUrl)
  useLayoutStore.getState().setHydratedLayout(state.layout)
  useSettingsStore.getState().setHydratedSettings(state.settings)
}

/**
 * Wire renderer stores to main's IPC.
 * Live updates only. Required initial snapshots are pulled and committed as one
 * hydration unit by pullInitialSyncState/applyInitialSyncState above.
 * Returns a cleanup function for the caller's useEffect.
 */
export function startIpcSync(): () => void {
  const offs = [
    ipcOn('tapes:added',       (tapes) => useTapesStore.getState().upsertMany(tapes)),
    ipcOn('tapes:updated',     (tape)  => useTapesStore.getState().upsert(tape)),
    ipcOn('tapes:updatedMany', (tapes) => useTapesStore.getState().upsertMany(tapes)),
    ipcOn('tapes:removed',     ({ tapeIds }) => {
      useTapesStore.getState().removeMany(tapeIds)
      tapeIds.forEach((id) => {
        useDownloadLogStore.getState().reset(id)
        useTapeActionResultsStore.getState().clearTape(id)
      })
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
    ipcOn('tapes:failed',    ({ tapeId, code }) => {
      useTapesStore.getState().clearProgress(tapeId)
      // The error caps the log as its newest (top) entry.
      useDownloadLogStore.getState().prepend(tapeId, { kind: 'error', text: downloadFailurePresentation(code) })
    }),
    ipcOn('tapes:log',       ({ tapeId, line }) =>
      useDownloadLogStore.getState().prepend(tapeId, { kind: 'line', text: line }),
    ),
    ipcOn('tapes:logReset',  ({ tapeId }) => useDownloadLogStore.getState().reset(tapeId)),

    ipcOn('binaries:progress', ({ name, operationId, percent, phase }) =>
      useBinariesStore.getState().setProgress(name, operationId, percent, phase),
    ),
  ]
  return () => offs.forEach((off) => off())
}
