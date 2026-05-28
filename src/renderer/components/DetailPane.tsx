import { useEffect, useRef, useState } from 'react'
import type { Item } from '@shared/domain'
import type { SidecarRaw } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import { useItemsStore } from '@renderer/store/items'
import { useSelectionStore } from '@renderer/store/selection'
import { formatTime } from '@renderer/lib/format'
import { Player } from './Player'
import { ChapterList } from './ChapterList'
import { RenameDialog } from './RenameDialog'
import { ExportDialog } from './ExportDialog'

type Chapter = { start_time: number; end_time: number; title: string }

export function DetailPane({ item }: { item: Item }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [sidecar, setSidecar] = useState<SidecarRaw | null>(null)
  const [sidecarError, setSidecarError] = useState<string | null>(null)
  const [showRename, setShowRename] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const select = useSelectionStore((s) => s.select)
  const progress = useItemsStore((s) => s.progress[item.id])

  useEffect(() => {
    setSidecar(null)
    setSidecarError(null)
    if (item.state !== 'downloaded') return
    let cancelled = false
    ipcInvoke('library:getSidecar', { itemId: item.id })
      .then((s) => { if (!cancelled) setSidecar(s) })
      .catch((err) => { if (!cancelled) setSidecarError(String(err)) })
    return () => { cancelled = true }
  }, [item.id, item.state, item.sidecarFilename])

  const chapters: Chapter[] = Array.isArray(sidecar?.chapters)
    ? (sidecar.chapters as Chapter[])
    : []

  const mediaUrl = item.filename
    ? `tapebox-media:///${encodeURIComponent(item.filename)}`
    : null

  function seek(seconds: number) {
    const v = videoRef.current
    if (!v) return
    v.currentTime = seconds
    void v.play().catch(() => {})
  }

  async function archive()   { await ipcInvoke('library:archive',   { itemIds: [item.id] }) }
  async function unarchive() { await ipcInvoke('library:unarchive', { itemIds: [item.id] }) }
  async function cancel()    { await ipcInvoke('downloads:cancel',  { itemId: item.id }) }
  async function retry()     { await ipcInvoke('downloads:retry',   { itemId: item.id }) }

  async function remove() {
    const ok = confirm('Remove this item and delete its files?')
    if (!ok) return
    await ipcInvoke('library:remove', { itemIds: [item.id], deleteFiles: true })
    select(null)
  }

  return (
    <div className="space-y-5 p-6">
      <div>
        <h2 className="text-lg font-medium">{item.title ?? item.sourceUrl}</h2>
        <p className="mt-1 text-xs text-zinc-500">
          {item.uploader ?? 'unknown uploader'}
          {item.durationSeconds != null && ` · ${formatTime(item.durationSeconds)}`}
          {' · '}
          {item.state}
          {item.archivedAtUtc && ' · archived'}
        </p>
        <p className="mt-1 truncate text-xs text-zinc-500">
          <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="hover:text-zinc-300">
            {item.sourceUrl}
          </a>
        </p>
        {item.slug && (
          <p className="mt-1 text-xs text-zinc-500">
            Slug: <span className="text-zinc-300">{item.slug}</span>
          </p>
        )}
      </div>

      {item.state === 'downloaded' && mediaUrl && (
        <Player ref={videoRef} src={mediaUrl} poster={item.thumbnailUrl ?? undefined} />
      )}

      {item.state !== 'downloaded' && (
        <div className="rounded border border-zinc-800 bg-zinc-900/40 p-4 text-sm">
          {progress
            ? `${progress.phase}… ${progress.percent.toFixed(0)}%`
            : item.state === 'failed'
              ? `Failed: ${item.lastError ?? 'unknown error'}`
              : item.state === 'paused'
                ? 'Paused. Click Resume below to continue.'
                : 'Waiting in queue…'}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {(item.state === 'queued' || item.state === 'probing' || item.state === 'downloading') && (
          <ActionButton onClick={cancel}>Cancel</ActionButton>
        )}
        {(item.state === 'failed' || item.state === 'paused') && (
          <ActionButton onClick={retry}>Resume</ActionButton>
        )}
        {item.state === 'downloaded' && (
          <>
            <ActionButton onClick={() => setShowExport(true)}>Export audio…</ActionButton>
            <ActionButton onClick={() => setShowRename(true)}>Rename…</ActionButton>
            {item.archivedAtUtc
              ? <ActionButton onClick={unarchive}>Move to Inbox</ActionButton>
              : <ActionButton onClick={archive}>Archive</ActionButton>}
          </>
        )}
        <ActionButton onClick={remove} danger>Remove</ActionButton>
      </div>

      {item.state === 'downloaded' && (
        <section>
          <h3 className="mb-2 text-sm font-medium text-zinc-300">Chapters</h3>
          {sidecarError && (
            <p className="text-xs text-red-400">{sidecarError}</p>
          )}
          {!sidecar && !sidecarError && (
            <p className="text-xs text-zinc-500">Loading…</p>
          )}
          {sidecar && <ChapterList chapters={chapters} onSeek={seek} />}
        </section>
      )}

      {showRename && (
        <RenameDialog item={item} onClose={() => setShowRename(false)} />
      )}
      {showExport && (
        <ExportDialog item={item} onClose={() => setShowExport(false)} />
      )}
    </div>
  )
}

function ActionButton({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void | Promise<void>
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={
        'rounded border px-3 py-1.5 text-xs transition ' +
        (danger
          ? 'border-red-900 text-red-300 hover:border-red-700 hover:bg-red-950/40'
          : 'border-zinc-700 text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800/60')
      }
    >
      {children}
    </button>
  )
}
