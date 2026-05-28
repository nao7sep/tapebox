import { useEffect, useState } from 'react'
import type { Settings } from '@shared/settings'
import { ipcInvoke } from '@renderer/ipc/client'
import { startIpcSync } from '@renderer/ipc/sync'
import { useItemsStore } from '@renderer/store/items'
import { useSelectionStore } from '@renderer/store/selection'
import { useBinariesStore } from '@renderer/store/binaries'
import { useEnumerationStore } from '@renderer/store/enumeration'
import { FirstRunDialog, allBinariesInstalled } from '@renderer/components/FirstRunDialog'
import { TopBar } from '@renderer/components/TopBar'
import { ItemList } from '@renderer/components/ItemList'
import { DetailPane } from '@renderer/components/DetailPane'
import { FilterChips } from '@renderer/components/FilterChips'
import { AddPlaylistModal } from '@renderer/components/AddPlaylistModal'
import { SettingsDialog } from '@renderer/components/SettingsDialog'
import { DropZone } from '@renderer/components/DropZone'

export default function App() {
  const items = useItemsStore((s) => s.items)
  const selectedId = useSelectionStore((s) => s.selectedId)
  const select = useSelectionStore((s) => s.select)
  const binaryStatuses = useBinariesStore((s) => s.statuses)
  const pendingEnum = useEnumerationStore((s) => s.pending)
  const closeEnum = useEnumerationStore((s) => s.close)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    const stop = startIpcSync()
    void ipcInvoke('settings:get').then(setSettings)
    return stop
  }, [])

  useEffect(() => {
    if (!showSettings) void ipcInvoke('settings:get').then(setSettings)
  }, [showSettings])

  useEffect(() => {
    if (selectedId && !items.some((i) => i.id === selectedId)) select(null)
  }, [items, selectedId, select])

  const selectedItem = items.find((i) => i.id === selectedId) ?? null
  const needsFirstRun = !allBinariesInstalled(binaryStatuses)

  return (
    <DropZone>
      <main className="flex h-screen flex-col">
        <header className="shrink-0 space-y-3 border-b border-zinc-800 p-4">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="text-xl font-medium tracking-tight">TapeBox</h1>
            <div className="flex items-baseline gap-4">
              {settings && (
                <p className="text-xs text-zinc-500">
                  <span className="text-zinc-300">{settings.libraryDir}</span>
                  {' · '}
                  Autostart <span className="text-zinc-300">{settings.autoStartDownloads ? 'on' : 'off'}</span>
                  {' · '}
                  Concurrency <span className="text-zinc-300">{settings.maxConcurrentDownloads}</span>
                </p>
              )}
              <button
                onClick={() => setShowSettings(true)}
                className="text-xs text-zinc-400 hover:text-zinc-100"
              >
                Settings
              </button>
            </div>
          </div>
          <TopBar />
          <FilterChips />
        </header>

        <div className="flex flex-1 overflow-hidden">
          <aside className="w-80 shrink-0 overflow-y-auto border-r border-zinc-800">
            <ItemList />
          </aside>
          <section className="flex-1 overflow-y-auto">
            {selectedItem ? (
              <DetailPane item={selectedItem} />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-sm text-zinc-500">
                Select a tape from the list.
              </div>
            )}
          </section>
        </div>

        {pendingEnum && (
          <AddPlaylistModal
            url={pendingEnum.url}
            sourceTitle={pendingEnum.sourceTitle}
            onClose={closeEnum}
          />
        )}

        {showSettings && (
          <SettingsDialog onClose={() => setShowSettings(false)} />
        )}

        {needsFirstRun && <FirstRunDialog />}
      </main>
    </DropZone>
  )
}
