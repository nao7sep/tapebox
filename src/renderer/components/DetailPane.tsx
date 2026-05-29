import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import type { Item } from '@shared/domain'
import type { SidecarRaw } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import { useItemsStore } from '@renderer/store/items'
import { useSelectionStore } from '@renderer/store/selection'
import { formatTime } from '@renderer/lib/format'
import { Player } from './Player'
import { ChapterList } from './ChapterList'
import { RenameModal } from './RenameModal'
import { ExportModal } from './ExportModal'

/**
 * Chapter shape as yt-dlp writes it into the sidecar. We validate at the
 * boundary because a malformed sidecar (manual edit, future yt-dlp change)
 * could otherwise feed NaN to <video>.currentTime.
 */
const SidecarChapterSchema = z.object({
  start_time: z.number(),
  end_time: z.number(),
  title: z.string(),
})
type Chapter = z.infer<typeof SidecarChapterSchema>

export function DetailPane({
  item,
  onOpenPlaylist,
}: {
  item: Item
  onOpenPlaylist: (url: string) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [sidecar, setSidecar] = useState<SidecarRaw | null>(null)
  const [sidecarError, setSidecarError] = useState<string | null>(null)
  const [showRename, setShowRename] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [copied, setCopied] = useState(false)
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

  const chapters: Chapter[] = (() => {
    const raw = sidecar?.chapters
    if (!Array.isArray(raw)) return []
    const parsed = z.array(SidecarChapterSchema).safeParse(raw)
    return parsed.success ? parsed.data : []
  })()

  const mediaUrl = item.filename
    ? `tapebox-media:///${encodeURIComponent(item.filename)}`
    : null

  function seek(seconds: number) {
    const v = videoRef.current
    if (!v) return
    v.currentTime = seconds
    void v.play().catch(() => {})
  }

  /**
   * Release the file handle before any operation that touches the file's
   * name or existence on disk. On Windows the OS refuses rename/unlink while
   * the file is open in a <video> element. On macOS/Linux it works but the
   * sidecar may be stale if the read happened before release.
   */
  function releaseMedia() {
    const v = videoRef.current
    if (!v) return
    v.pause()
    v.removeAttribute('src')
    v.load()
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(item.sourceUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable; nothing actionable to show */ }
  }

  async function archive()   { await ipcInvoke('library:archive',   { itemIds: [item.id] }) }
  async function unarchive() { await ipcInvoke('library:unarchive', { itemIds: [item.id] }) }
  async function cancel()    { await ipcInvoke('downloads:cancel',  { itemId: item.id }) }
  async function retry()     { await ipcInvoke('downloads:retry',   { itemId: item.id }) }

  async function remove() {
    const ok = confirm('Remove this item and delete its files?')
    if (!ok) return
    releaseMedia()
    await ipcInvoke('library:remove', { itemIds: [item.id], deleteFiles: true })
    select(null)
  }

  function openRename() {
    releaseMedia()
    setShowRename(true)
  }

  return (
    <div className="space-y-5 p-6">
      <div>
        <h2 className="text-lg font-medium">{item.title ?? item.sourceUrl}</h2>
        <p className="mt-1 text-xs text-zinc-400">
          {item.uploader ?? 'unknown uploader'}
          {item.durationSeconds != null && ` · ${formatTime(item.durationSeconds)}`}
          {' · '}
          {item.isPlaylist ? 'playlist or channel' : item.state}
          {item.archivedAtUtc && ' · archived'}
        </p>
        <p className="mt-1 truncate text-xs text-zinc-400">
          <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="hover:text-zinc-300">
            {item.sourceUrl}
          </a>
        </p>
        {item.slug && (
          <p className="mt-1 text-xs text-zinc-400">
            Slug: <span className="text-zinc-300">{item.slug}</span>
          </p>
        )}
      </div>

      {item.state === 'downloaded' && mediaUrl && !showRename && (
        <Player ref={videoRef} src={mediaUrl} poster={item.thumbnailUrl ?? undefined} />
      )}

      {item.isPlaylist ? (
        <div className="rounded-lg border border-indigo-900/50 bg-indigo-950/20 p-5">
          <h3 className="flex items-center gap-2 text-sm font-medium text-indigo-200">
            <PlaylistGlyph />
            This is a playlist or channel
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-zinc-300">
            TapeBox adds one video at a time here. To choose which videos to take
            from this, open the scanner — it lists every video so you can pick.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <ActionButton onClick={() => onOpenPlaylist(item.sourceUrl)}>Open scanner</ActionButton>
            <ActionButton onClick={copyUrl}>{copied ? 'Copied' : 'Copy URL'}</ActionButton>
          </div>
        </div>
      ) : (
        item.state !== 'downloaded' && (
          <div className="rounded border border-zinc-800 bg-zinc-900/40 p-4 text-sm">
            {progress
              ? `${progress.phase}… ${progress.percent.toFixed(0)}%`
              : item.state === 'failed'
                ? `Failed: ${item.lastError ?? 'unknown error'}`
                : item.state === 'paused'
                  ? 'Paused. Click Resume below to continue.'
                  : 'Waiting in queue…'}
          </div>
        )
      )}

      <div className="flex flex-wrap gap-2">
        {!item.isPlaylist && (item.state === 'queued' || item.state === 'probing' || item.state === 'downloading') && (
          <ActionButton onClick={cancel}>Cancel</ActionButton>
        )}
        {!item.isPlaylist && (item.state === 'failed' || item.state === 'paused') && (
          <ActionButton onClick={retry}>Resume</ActionButton>
        )}
        {item.state === 'downloaded' && (
          <>
            <ActionButton onClick={() => setShowExport(true)}>Export audio…</ActionButton>
            <ActionButton onClick={openRename}>Rename…</ActionButton>
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
            <p className="text-xs text-zinc-400">Loading…</p>
          )}
          {sidecar && <ChapterList chapters={chapters} onSeek={seek} />}
        </section>
      )}

      {showRename && (
        <RenameModal item={item} onClose={() => setShowRename(false)} />
      )}
      {showExport && (
        <ExportModal item={item} onClose={() => setShowExport(false)} />
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

/** Stacked-lines glyph (a "list" mark) for the playlist/channel pane. */
function PlaylistGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="13" y2="17" />
      <polygon points="17,15 22,18 17,21" fill="currentColor" stroke="none" />
    </svg>
  )
}
