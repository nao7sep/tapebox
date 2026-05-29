import { useEffect, useRef, useState } from 'react'
import type { Settings } from '@shared/settings'
import { ipcInvoke } from '@renderer/ipc/client'
import { startIpcSync } from '@renderer/ipc/sync'
import { useItemsStore } from '@renderer/store/items'
import { useSelectionStore } from '@renderer/store/selection'
import { useBinariesStore, allBinariesInstalled } from '@renderer/store/binaries'
import { BinariesModal } from '@renderer/components/BinariesModal'
import { TopBar } from '@renderer/components/TopBar'
import { ItemList } from '@renderer/components/ItemList'
import { DetailPane } from '@renderer/components/DetailPane'
import { FilterChips } from '@renderer/components/FilterChips'
import { AddPlaylistModal } from '@renderer/components/AddPlaylistModal'
import { SettingsModal } from '@renderer/components/SettingsModal'
import { AboutModal } from '@renderer/components/AboutModal'
import { ShortcutsModal } from '@renderer/components/ShortcutsModal'
import { HeaderMenu } from '@renderer/components/HeaderMenu'
import { StatusBar } from '@renderer/components/StatusBar'
import { DropZone } from '@renderer/components/DropZone'

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
  const items = useItemsStore((s) => s.items)
  const selectedId = useSelectionStore((s) => s.selectedId)
  const select = useSelectionStore((s) => s.select)
  const binaryStatuses = useBinariesStore((s) => s.statuses)
  const binariesModalOpen = useBinariesStore((s) => s.modalOpen)
  const openBinariesModal = useBinariesStore((s) => s.openModal)
  const [showSettings, setShowSettings] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showPlaylist, setShowPlaylist] = useState(false)
  const [playlistInitialUrl, setPlaylistInitialUrl] = useState('')
  const decidedFirstRun = useRef(false)

  function openPlaylist(initialUrl = '') {
    setPlaylistInitialUrl(initialUrl)
    setShowPlaylist(true)
  }

  useEffect(() => {
    const stop = startIpcSync()
    void ipcInvoke('settings:get').then((s) => {
      if (!s.autoCheckBinaryUpdates) return
      if (!lastCheckedStale(s.binaries)) return
      // Best-effort background check: main logs any failure (per-binary +
      // summary). Swallow here so it never surfaces as an unhandled rejection
      // — the user didn't trigger it, so we don't interrupt them on failure.
      const store = useBinariesStore.getState()
      store.setChecking(true)
      void ipcInvoke('binaries:checkUpdates')
        .then(store.setStatuses)
        .catch(() => {})
        .finally(() => useBinariesStore.getState().setChecking(false))
    })
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
    if (selectedId && !items.some((i) => i.id === selectedId)) select(null)
  }, [items, selectedId, select])

  const selectedItem = items.find((i) => i.id === selectedId) ?? null

  return (
    <DropZone>
      <main className="flex h-screen flex-col">
        <header className="shrink-0 space-y-3 border-b border-zinc-800 p-4">
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-xl font-medium tracking-tight">TapeBox</h1>
            <HeaderMenu
              onPlaylist={() => openPlaylist()}
              onSettings={() => setShowSettings(true)}
              onTools={() => openBinariesModal()}
              onShortcuts={() => setShowShortcuts(true)}
              onAbout={() => setShowAbout(true)}
            />
          </div>
          <TopBar clipboardEnabled={!showPlaylist} />
          <FilterChips />
        </header>

        <div className="flex flex-1 overflow-hidden">
          <aside className="w-80 shrink-0 overflow-y-auto border-r border-zinc-800">
            <ItemList />
          </aside>
          <section className="flex-1 overflow-y-auto">
            {selectedItem ? (
              <DetailPane item={selectedItem} onOpenPlaylist={openPlaylist} />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-sm text-zinc-400">
                Select a tape from the list.
              </div>
            )}
          </section>
        </div>

        {showPlaylist && (
          <AddPlaylistModal initialUrl={playlistInitialUrl} onClose={() => setShowPlaylist(false)} />
        )}

        {showSettings && (
          <SettingsModal onClose={() => setShowSettings(false)} />
        )}

        {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}

        {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}

        {binariesModalOpen && <BinariesModal />}

        <StatusBar />
      </main>
    </DropZone>
  )
}
