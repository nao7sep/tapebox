import { useEffect, useRef, useState } from 'react'
import type { BinaryStatus } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import { presentFailure } from '@renderer/lib/presentFailure'
import { LAYOUT_BOUNDS, detailPaneWidth } from '@shared/layout'
import { startIpcSync } from '@renderer/ipc/sync'
import { useTapesStore } from '@renderer/store/tapes'
import { useSelectionStore } from '@renderer/store/selection'
import { useFilterStore } from '@renderer/store/filter'
import {
  useBinariesStore,
  binariesNeedAttention,
} from '@renderer/store/binaries'
import { useMediaStore } from '@renderer/store/media'
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
import { PlaybackToggles } from '@renderer/components/PlaybackToggles'
import { ScanPageModal } from '@renderer/components/ScanPageModal'
import { SettingsModal } from '@renderer/components/SettingsModal'
import { AboutModal } from '@renderer/components/AboutModal'
import { ShortcutsModal } from '@renderer/components/ShortcutsModal'
import { HeaderMenu } from '@renderer/components/HeaderMenu'
import { StatusBar } from '@renderer/components/StatusBar'
import { Toaster } from '@renderer/components/Toaster'
import { TapeImportReceiver } from '@renderer/components/TapeImportReceiver'

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
  const [pageInitialUrl, setPageInitialUrl] = useState('')
  const decidedFirstRun = useRef(false)
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
  const leftPaneIntent = useLayoutStore((s) => s.layout.leftPaneWidth)
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

  useEffect(() => {
    const stop = startIpcSync()
    // Hydrate the loopback media server's base URL. Without it the player can't
    // build a source; the server is already listening before this window loaded,
    // so this resolves effectively immediately.
    // Each hydrate handler logs the authoritative error in main (handle()
    // re-throws); these renderer-side catches keep a rejected invoke from
    // surfacing as an unhandledrejection and add the developer-only vantage.
    void ipcInvoke('media:endpoint')
      .then((e) => useMediaStore.getState().setBaseUrl(e.baseUrl))
      .catch((err) => log.debug('media endpoint hydrate failed', { error: describeError(err) }))
    void ipcInvoke('layout:get')
      .then((l) => useLayoutStore.getState().setLayout(l))
      .catch((err) => log.debug('layout hydrate failed', { error: describeError(err) }))
    void ipcInvoke('settings:get')
      .then(async (s) => {
        useSettingsStore.getState().setSettings(s)
        if (!s.checkUpdatesAtLaunch) return
        // The recorded facts live in their own store now, so read the last-check
        // times from a status snapshot rather than from settings.
        const statuses = await ipcInvoke('binaries:status')
        if (!lastCheckedStale(statuses)) return
        // Best-effort background check the user didn't trigger. The application
        // store owns the complete check lifecycle; a failure remains available in
        // Managed tools without interrupting launch with a toast.
        void useBinariesStore.getState().checkUpdates()
      })
      .catch((err) => log.debug('settings hydrate failed', { error: describeError(err) }))
    return stop
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
            onRevealLog={() => void ipcInvoke('app:revealLog')}
          />
        </header>

        <div ref={contentRowRef} className="flex flex-1 overflow-hidden">
          <aside
            style={{ width: leftPaneWidth }}
            className="relative flex shrink-0 flex-col border-r border-zinc-700"
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-700 px-3 py-2.5">
              <FilterChips />
              <PlaybackToggles />
            </div>
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
              onResize={(w) => patchLayout({ leftPaneWidth: w }, false)}
              onCommit={(w) => patchLayout({ leftPaneWidth: w }, true)}
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
