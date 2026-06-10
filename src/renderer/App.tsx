import { useEffect, useRef, useState } from 'react'
import type { Settings } from '@shared/settings'
import { ipcInvoke } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import { startIpcSync } from '@renderer/ipc/sync'
import { useTapesStore } from '@renderer/store/tapes'
import { useSelectionStore } from '@renderer/store/selection'
import { useFilterStore } from '@renderer/store/filter'
import { useBinariesStore, allBinariesInstalled } from '@renderer/store/binaries'
import { useMediaStore } from '@renderer/store/media'
import { useSettingsStore } from '@renderer/store/settings'
import { useLayoutStore, patchLayout } from '@renderer/store/layout'
import { useTapeRemoval } from '@renderer/lib/useTapeRemoval'
import { useListKeyboard } from '@renderer/lib/useListKeyboard'
import { useImportMedia } from '@renderer/lib/useImportMedia'
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
import { DropZone } from '@renderer/components/DropZone'
import { ImportResultModal } from '@renderer/components/ImportResultModal'
import { useImportResultStore } from '@renderer/store/importResult'

/** Skip the startup auto-check if any binary was checked within this window. */
const AUTO_CHECK_STALE_MS = 24 * 60 * 60 * 1000

function lastCheckedStale(binaries: Settings['binaries']): boolean {
  const timestamps = Object.values(binaries)
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
  const [showSettings, setShowSettings] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showScanPage, setShowScanPage] = useState(false)
  const [pageInitialUrl, setPageInitialUrl] = useState('')
  const decidedFirstRun = useRef(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const { requestRemove, confirmModal } = useTapeRemoval(videoRef)
  useListKeyboard(requestRemove)
  const leftPaneWidth = useLayoutStore((s) => s.layout.leftPaneWidth)
  const filter = useFilterStore((s) => s.filter)
  const importMedia = useImportMedia()
  const importResult = useImportResultStore((s) => s.result)
  const clearImportResult = useImportResultStore((s) => s.clear)

  function openScanPage(initialUrl = '') {
    setPageInitialUrl(initialUrl)
    setShowScanPage(true)
  }

  async function importFiles() {
    const picked = await ipcInvoke('dialog:pickFiles', { title: 'Import media files' })
    // Drop any sidecar picked alongside media — it's paired by stem automatically.
    await importMedia(picked.filter((p) => !p.toLowerCase().endsWith('.json')))
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
      .then((s) => {
        useSettingsStore.getState().setSettings(s)
        if (!s.autoCheckBinaryUpdates) return
        if (!lastCheckedStale(s.binaries)) return
        // Best-effort background check the user didn't trigger: main logs the
        // authoritative per-binary + summary outcome, so here we only note at debug
        // that the call rejected — never an error toast that interrupts them.
        const store = useBinariesStore.getState()
        store.setChecking(true)
        void ipcInvoke('binaries:checkUpdates')
          .then(store.setStatuses)
          .catch((err) => log.debug('background binary check rejected', { error: describeError(err) }))
          .finally(() => useBinariesStore.getState().setChecking(false))
      })
      .catch((err) => log.debug('settings hydrate failed', { error: describeError(err) }))
    return stop
  }, [])

  // Once the first status snapshot arrives, open the tools modal if anything is
  // missing. Decided once so it doesn't reopen after the user closes it.
  useEffect(() => {
    if (decidedFirstRun.current || binaryStatuses.length === 0) return
    decidedFirstRun.current = true
    if (!allBinariesInstalled(binaryStatuses)) openBinariesModal()
  }, [binaryStatuses, openBinariesModal])

  useEffect(() => {
    if (selectedId && !tapes.some((i) => i.id === selectedId)) select(null)
  }, [tapes, selectedId, select])

  const selectedTape = tapes.find((i) => i.id === selectedId) ?? null

  return (
    <DropZone>
      <main className="flex h-screen flex-col">
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

        <div className="flex flex-1 overflow-hidden">
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
              <div className="min-h-0 flex-1 overflow-y-auto">
                <TapeList />
              </div>
            )}
            <ResizeHandle
              edge="right"
              size={leftPaneWidth}
              min={200}
              max={720}
              onResize={(w) => patchLayout({ leftPaneWidth: w }, false)}
              onCommit={(w) => patchLayout({ leftPaneWidth: w }, true)}
            />
          </aside>
          <section className="flex-1 overflow-y-auto">
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

        {importResult && (
          <ImportResultModal result={importResult} onClose={clearImportResult} />
        )}

        <StatusBar />
        <Toaster />
      </main>
    </DropZone>
  )
}
