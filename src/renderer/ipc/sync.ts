import { invalidateTapeActions } from '@renderer/lib/runTapeAction'
import { useBoxActionResultsStore } from '@renderer/store/boxActionResults'
import { ipcInvoke, ipcOn } from './client'
import { useArchiveStore } from '@renderer/store/archive'
import { useSelectionStore } from '@renderer/store/selection'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useBinariesStore } from '@renderer/store/binaries'
import { useRuntimeStore } from '@renderer/store/runtime'
import { useDownloadLogStore } from '@renderer/store/downloadLog'
import { downloadFailurePresentation } from '@renderer/lib/downloadFailure'
import { useMediaStore } from '@renderer/store/media'
import { useLayoutStore } from '@renderer/store/layout'
import { useSettingsStore } from '@renderer/store/settings'
import type { Tape } from '@shared/domain'
import type { BinaryStatus, RuntimeInfo } from '@shared/ipc-contract'
import type { Layout } from '@shared/layout'
import type { Settings } from '@shared/settings'
import { useTapeActionResultsStore } from '@renderer/store/tapeActionResults'
import { useToastStore } from '@renderer/store/toast'
import { useOrderFailuresStore } from '@renderer/store/orderFailures'
import { message } from '@shared/i18n/translate'

/** Shown when main reports that library changes are not reaching disk. */
export const LIBRARY_SAVE_FAILED_MESSAGE = message('app.librarySaveFailed')

export type InitialSyncState = {
  binaries: BinaryStatus[]
  runtime: RuntimeInfo
  mediaBaseUrl: string
  layout: Layout
  settings: Settings
}

/**
 * Pull every required renderer mirror. The catalog is not pulled: subscribing
 * makes main send it as library:current, on the same ordered channel as every
 * later catalog event, and before the subscription's reply, so the window has
 * one source for it and nothing to merge.
 */
export async function pullInitialSyncState(): Promise<InitialSyncState> {
  const [, binaries, runtime, media, layout, settings] = await Promise.all([
    ipcInvoke('library:subscribe'),
    ipcInvoke('binaries:status'),
    ipcInvoke('app:runtimeInfo'),
    ipcInvoke('media:endpoint'),
    ipcInvoke('layout:get'),
    ipcInvoke('settings:get'),
  ])
  return { binaries, runtime, mediaBaseUrl: media.baseUrl, layout, settings }
}

export function applyInitialSyncState(state: InitialSyncState): void {
  useBinariesStore.getState().setStatuses(state.binaries)
  useRuntimeStore.getState().setInfo(state.runtime)
  useMediaStore.getState().setBaseUrl(state.mediaBaseUrl)
  useLayoutStore.getState().setHydratedLayout(state.layout)
  useSettingsStore.getState().setHydratedSettings(state.settings)
}

export type IpcSync = {
  stop: () => void
}

/** Own the live subscriptions for one mounted App. */
export function startIpcSync(): IpcSync {
  function upsert(tapes: Tape[]): void {
    useTapesStore.getState().upsertMany(tapes)
  }

  const offs = [
    ipcOn('library:current', ({ tapes, boxes }) => {
      useTapesStore.getState().setAll(tapes)
      useBoxesStore.getState().setBoxes(boxes)
    }),
    ipcOn('library:opened', ({ tapes, boxes }) => {
      useDownloadLogStore.setState({ entries: {}, trimmed: {} })
      useMediaStore.setState((media) => ({ collectionRevision: media.collectionRevision + 1 }))
      invalidateTapeActions()
      useTapeActionResultsStore.setState({ byTape: {} })
      useBoxActionResultsStore.setState({ results: {} })
      useSelectionStore.getState().select(null)
      useArchiveStore.getState().selectBox(null)
      // Invalidate replies from the previous collection, including lists that
      // reuse the same IDs. Advancing counters avoids a new attempt's ABA match.
      const attempts = useOrderFailuresStore.getState().attempts
      useOrderFailuresStore.setState({
        boxes: null, archiveTapes: {}, pending: {},
        attempts: Object.fromEntries(Object.entries(attempts).map(([key, value]) => [key, value! + 1])),
      })
      useTapesStore.setState({ tapes, progress: {}, stalled: {} })
      useBoxesStore.setState({ collection: {}, boxes, editingId: null, draftName: '', pendingRenames: 0 })
    }),
    ipcOn('tapes:added',       upsert),
    ipcOn('tapes:updated',     (tape) => upsert([tape])),
    ipcOn('tapes:updatedMany', upsert),
    ipcOn('tapes:removed',     ({ tapeIds }) => {
      useTapesStore.getState().removeMany(tapeIds)
      tapeIds.forEach((id) => {
        useDownloadLogStore.getState().reset(id)
        useTapeActionResultsStore.getState().clearTape(id)
      })
    }),
    ipcOn('boxes:changed',    (boxes) => useBoxesStore.getState().setBoxes(boxes)),
    ipcOn('library:saveFailed', () => useToastStore.getState().notify(LIBRARY_SAVE_FAILED_MESSAGE, 'error')),
    ipcOn('tapes:progress',  ({ tapeId, phase, percent, speedBps, etaSec }) =>
      useTapesStore.getState().setProgress(tapeId, { phase, percent, speedBps, etaSec }),
    ),
    ipcOn('tapes:stalled',   ({ tapeId, stalled }) => useTapesStore.getState().setStalled(tapeId, stalled)),
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
  return {
    stop() {
      offs.forEach((off) => off())
    },
  }
}
