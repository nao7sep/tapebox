import { useEffect, useRef, useState } from 'react'
import type { BinaryStatus } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import { presentFailure } from '@renderer/lib/presentFailure'
import { LAYOUT_BOUNDS, detailPaneWidth } from '@shared/layout'
import { applyInitialSyncState, pullInitialSyncState, startIpcSync } from '@renderer/ipc/sync'
import { useTapesStore } from '@renderer/store/tapes'
import { useSelectionStore } from '@renderer/store/selection'
import { useFilterStore } from '@renderer/store/filter'
import {
  useBinariesStore,
  binariesNeedAttention,
} from '@renderer/store/binaries'
import { useSettingsStore } from '@renderer/store/settings'
import { useLayoutStore, patchLayout } from '@renderer/store/layout'
import { usePaneSize } from '@renderer/lib/usePaneSize'
import { useTapeRemoval } from '@renderer/lib/useTapeRemoval'
import { useAppShortcuts } from '@renderer/lib/useAppShortcuts'
import { useImportMedia } from '@renderer/lib/useImportMedia'
import { denyUnhandledExternalDrop } from '@renderer/lib/externalDrop'
import { useUiFont } from '@renderer/lib/useUiFont'
import { ResizeHandle } from '@renderer/components/ResizeHandle'
import { BinariesModal } from '@renderer/components/BinariesModal'
import { TopBar } from '@renderer/components/TopBar'
import { TapeList } from '@renderer/components/TapeList'
import { ArchiveOrganizer } from '@renderer/components/ArchiveOrganizer'
import { DetailPane } from '@renderer/components/DetailPane'
import { FilterChips } from '@renderer/components/FilterChips'
import { PlaybackSettingResults, PlaybackToggles } from '@renderer/components/PlaybackToggles'
import { ScanPageModal } from '@renderer/components/ScanPageModal'
import { SettingsModal } from '@renderer/components/SettingsModal'
import { AboutModal } from '@renderer/components/AboutModal'
import { ShortcutsModal } from '@renderer/components/ShortcutsModal'
import { HeaderMenu } from '@renderer/components/HeaderMenu'
import { StatusBar } from '@renderer/components/StatusBar'
import { Toaster } from '@renderer/components/Toaster'
import { TapeImportReceiver } from '@renderer/components/TapeImportReceiver'
import { InlineError, Spinner } from '@renderer/components/ui'
import { LayoutWriteResult } from '@renderer/components/LayoutWriteResult'

/** Skip the startup auto-check if any binary was checked within this window. */
const AUTO_CHECK_STALE_MS = 24 * 60 * 60 * 1000

// The last-check times now come from the binaries:status snapshot (each status
// mirrors the recorded dependency facts), not from settings — the facts moved to
// their own store (persisted-store-separation-conventions).
function lastCheckedStale(statuses: BinaryStatus[]): boolean {
  const timestamps = statuses
    .map((b) => b.lastCheckedAtUtc)
    .filter((t): t is string => t !== null)
  if (timestamps.length === 0) return true
  const mostRecent = timestamps.sort().at(-1)!
  return Date.now() - Date.parse(mostRecent) > AUTO_CHECK_STALE_MS
}

export default function App() {
  const [loadError, setLoadError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const hydrationGeneration = useRef(0)
  const loading = !ready && !loadError

  function hydrate() {
    const generation = ++hydrationGeneration.current
    setLoadError(null)
    void pullInitialSyncState().then(
      (state) => {
        if (hydrationGeneration.current !== generation) return
        applyInitialSyncState(state)
        setReady(true)
      },
      (error) => {
        if (hydrationGeneration.current !== generation) return
        setLoadError(presentFailure(
          error,
          'TapeBox could not load the library and settings. Nothing has been changed; try again.',
          'application hydration failed',
        ))
      },
    )
  }

  useEffect(() => {
    const stop = startIpcSync()
    hydrate()
    return () => {
      hydrationGeneration.current += 1
      stop()
    }
  }, [])

  if (!ready) {
    return (
      <main className="flex h-screen flex-col">
        <header className="shrink-0 border-b border-zinc-700 px-4 py-3">
          <h1 className="text-xl font-medium tracking-tight">TapeBox</h1>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-zinc-300"><Spinner /> Loading…</p>
          ) : (
            <div className="w-full max-w-xl space-y-3">
              <InlineError>{loadError}</InlineError>
              <button
                type="button"
                onClick={hydrate}
                className="rounded border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 hover:bg-zinc-700"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </main>
    )
  }

  return <HydratedApp />
}

function HydratedApp() {
  const tapes = useTapesStore((s) => s.tapes)
  const selectedId = useSelectionStore((s) => s.selectedId)
  const select = useSelectionStore((s) => s.select)
  const binaryStatuses = useBinariesStore((s) => s.statuses)
  const binariesModalOpen = useBinariesStore((s) => s.modalOpen)
  const openBinariesModal = useBinariesStore((s) => s.openModal)
  const settings = useSettingsStore((s) => s.settings)
  const [showSettings, setShowSettings] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showScanPage, setShowScanPage] = useState(false)
  const [revealLogError, setRevealLogError] = useState<string | null>(null)
  const [pageInitialUrl, setPageInitialUrl] = useState('')
  const decidedFirstRun = useRef(false)
  const startedAutoCheck = useRef(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const { requestRemove, confirmModal } = useTapeRemoval(videoRef)
  useAppShortcuts(() => setShowShortcuts(true))
  // Apply the configured UI font; reverts to the @theme default when cleared.
  useUiFont()
  // The persisted leftPaneWidth is the drag-set INTENT; the displayed width is
  // derived from it and the live content row, narrowing toward the pane min when
  // the window shrinks and returning to the intent when it grows (display-only,
  // never persisted). The far-side reserve is the detail + chapters pane mins —
  // the same Σ the window minimum and the splitter clamp use.
  const leftPaneIntent = useLayoutStore((s) => s.layout!.leftPaneWidth)
  const { containerRef: contentRowRef, displayed: leftPaneWidth } = usePaneSize<HTMLDivElement>(
    leftPaneIntent,
    false,
    {
      siblingMin: detailPaneWidth.min + LAYOUT_BOUNDS.chaptersPaneWidth.min,
      min: LAYOUT_BOUNDS.leftPaneWidth.min,
      max: LAYOUT_BOUNDS.leftPaneWidth.max,
    },
  )
  const filter = useFilterStore((s) => s.filter)
  const importMedia = useImportMedia()

  function openScanPage(initialUrl = '') {
    setPageInitialUrl(initialUrl)
    setShowScanPage(true)
  }

  async function importFiles() {
    try {
      const picked = await ipcInvoke('dialog:pickFiles', { title: 'Import tapes — pick their .json sidecars' })
      if (picked.length === 0) return
      // Imported tapes enter Inbox, so show the same receiving collection that owns
      // the drop path before the shared admission/operation reports its result.
      useFilterStore.getState().setFilter('inbox')
      await importMedia(picked, [], {
        operationKey: `picker:${JSON.stringify([...new Set(picked)].sort())}`,
        entryKey: 'picker',
      })
    } catch (error) {
      useFilterStore.getState().setFilter('inbox')
      await importMedia(
        [],
        [{ path: 'Import files', reason: presentFailure(error, 'The file picker could not be opened. Try importing again.', 'import file picker failed'), severity: 'error' }],
        { operationKey: 'picker', entryKey: 'picker' },
      )
    }
  }

  async function revealLog() {
    setRevealLogError(null)
    try {
      await ipcInvoke('app:revealLog')
    } catch (error) {
      setRevealLogError(presentFailure(
        error,
        'The session log could not be shown in its folder. Try again.',
        'session log reveal failed',
      ))
    }
  }

  useEffect(() => {
    if (startedAutoCheck.current || !settings?.checkUpdatesAtLaunch || !lastCheckedStale(binaryStatuses)) return
    startedAutoCheck.current = true
    // Best-effort background check the user didn't trigger. Managed tools owns
    // its complete lifecycle and stable failure presentation.
    void useBinariesStore.getState().checkUpdates()
  }, [])

  // Once both settings and the first status snapshot are in, do the one-shot startup
  // decision (decided once so it doesn't repeat after the user closes the modal).
  // Blocking-first-run (managed-runtime-dependencies-conventions): a required tool
  // that is not installed opens the tools surface as an instruction — regardless of
  // the check toggle, since downloads are blocked without it. An available update is
  // NOT a reason to interrupt; it surfaces passively in the status bar. Nothing
  // auto-downloads.
  useEffect(() => {
    if (decidedFirstRun.current || !settings || binaryStatuses.length === 0) return
    decidedFirstRun.current = true
    if (binariesNeedAttention(binaryStatuses)) openBinariesModal()
  }, [settings, binaryStatuses, openBinariesModal])

  useEffect(() => {
    if (selectedId && !tapes.some((i) => i.id === selectedId)) select(null)
  }, [tapes, selectedId, select])

  const selectedTape = tapes.find((i) => i.id === selectedId) ?? null

  return (
    <main
      className="flex h-screen flex-col"
      onDragOver={denyUnhandledExternalDrop}
      onDrop={denyUnhandledExternalDrop}
    >
        <header className="flex shrink-0 items-center gap-4 border-b border-zinc-700 px-4 py-2.5">
          <h1 className="shrink-0 text-xl font-medium tracking-tight">TapeBox</h1>
          <div className="flex min-w-0 flex-1 justify-center">
            <div className="w-full max-w-5xl">
              <TopBar clipboardEnabled={!showScanPage} />
            </div>
          </div>
          <HeaderMenu
            onScanPage={() => openScanPage()}
            onImport={() => void importFiles()}
            onSettings={() => setShowSettings(true)}
            onTools={() => openBinariesModal()}
            onShortcuts={() => setShowShortcuts(true)}
            onAbout={() => setShowAbout(true)}
            onRevealLog={() => void revealLog()}
          />
        </header>

        {revealLogError && (
          <InlineError
            className="mx-4 my-2 shrink-0"
            onDismiss={() => setRevealLogError(null)}
            closeLabel="Close session log result"
          >
            {revealLogError}
          </InlineError>
        )}

        <div ref={contentRowRef} className="flex flex-1 overflow-hidden">
          <aside
            style={{ width: leftPaneWidth }}
            className="relative flex shrink-0 flex-col border-r border-zinc-700"
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-700 px-3 py-2.5">
              <FilterChips />
              <PlaybackToggles />
            </div>
            <PlaybackSettingResults />
            <LayoutWriteResult field="leftPaneWidth" className="m-3 mb-0 shrink-0" />
            {filter === 'archived' ? (
              <ArchiveOrganizer />
            ) : (
              <TapeImportReceiver>
                <TapeList />
              </TapeImportReceiver>
            )}
            <ResizeHandle
              edge="right"
              // Start the drag from the displayed width; the handle reports the new
              // INTENT (bounded by the pane's own min/max), which we persist on
              // commit. The displayed width above re-derives from that intent
              // against the live row — so a drag that overshoots the room is held
              // back visually while the intent is kept for when the window grows.
              size={leftPaneWidth}
              min={LAYOUT_BOUNDS.leftPaneWidth.min}
              max={LAYOUT_BOUNDS.leftPaneWidth.max}
              onResize={(w) => void patchLayout({ leftPaneWidth: w }, false)}
              onCommit={(w) => void patchLayout({ leftPaneWidth: w }, true)}
            />
          </aside>
          <section
            className="flex-1 overflow-y-auto min-w-0"
            style={{ minWidth: detailPaneWidth.min }}
          >
            {selectedTape ? (
              <DetailPane
                tape={selectedTape}
                videoRef={videoRef}
                onRequestRemove={requestRemove}
                onScanPage={openScanPage}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-sm text-zinc-300">
                Select a tape from the list.
              </div>
            )}
          </section>
        </div>

        {showScanPage && (
          <ScanPageModal initialUrl={pageInitialUrl} onClose={() => setShowScanPage(false)} />
        )}

        {showSettings && (
          <SettingsModal onClose={() => setShowSettings(false)} />
        )}

        {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}

        {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}

        {binariesModalOpen && <BinariesModal />}

        {confirmModal}

        <StatusBar />
        <Toaster />
    </main>
  )
}
