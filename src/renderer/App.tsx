import { useEffect, useState } from 'react'
import type { Settings } from '@shared/settings'
import { ipcInvoke } from '@renderer/ipc/client'
import { startIpcSync } from '@renderer/ipc/sync'
import { useItemsStore } from '@renderer/store/items'

export default function App() {
  const items = useItemsStore((s) => s.items)
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    const stop = startIpcSync()
    void ipcInvoke('settings:get').then(setSettings)
    return stop
  }, [])

  return (
    <main className="min-h-screen p-8">
      <header className="mb-8">
        <h1 className="text-2xl font-medium tracking-tight">TapeBox</h1>
        {settings && (
          <p className="mt-1 text-xs text-zinc-500">
            Library: <span className="text-zinc-300">{settings.libraryDir}</span>
            {' · '}
            Autostart: <span className="text-zinc-300">{settings.autoStartDownloads ? 'on' : 'off'}</span>
            {' · '}
            Concurrency: <span className="text-zinc-300">{settings.maxConcurrentDownloads}</span>
          </p>
        )}
      </header>

      {items.length === 0 ? (
        <p className="text-zinc-500">The box is empty.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="rounded border border-zinc-800 px-3 py-2">
              <div className="text-sm">{item.title ?? item.sourceUrl}</div>
              <div className="text-xs text-zinc-500">
                {item.state}
                {item.archivedAtUtc && ' · archived'}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
