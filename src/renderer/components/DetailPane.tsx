import { useEffect, useState, type RefObject } from 'react'
import { z } from 'zod'
import type { Item } from '@shared/domain'
import type { SidecarRaw } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import { useItemsStore } from '@renderer/store/items'
import { useMediaStore } from '@renderer/store/media'
import { useSettingsStore } from '@renderer/store/settings'
import { useLayoutStore, patchLayout } from '@renderer/store/layout'
import { releaseVideo } from '@renderer/lib/video'
import { useEnforcedMute } from '@renderer/lib/useEnforcedMute'
import { formatBytes, formatTime } from '@renderer/lib/format'
import { IndeterminateBar, ProgressBar } from './Progress'
import { Player } from './Player'
import { ChapterList } from './ChapterList'
import { RenameModal } from './RenameModal'
import { ExportModal } from './ExportModal'
import { ResizeHandle } from './ResizeHandle'
import { MoveToBoxButton } from './MoveToBoxButton'
import { CaptionedPanel } from './ui'

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
  videoRef,
  onRequestRemove,
  onOpenPlaylist,
}: {
  item: Item
  videoRef: RefObject<HTMLVideoElement | null>
  onRequestRemove: (item: Item) => void
  onOpenPlaylist: (url: string) => void
}) {
  const [sidecar, setSidecar] = useState<SidecarRaw | null>(null)
  const [sidecarError, setSidecarError] = useState<string | null>(null)
  const [showRename, setShowRename] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const progress = useItemsStore((s) => s.progress[item.id])
  const mediaBase = useMediaStore((s) => s.baseUrl)
  const autoplay = useSettingsStore((s) => s.settings?.autoplay ?? true)
  const playSound = useSettingsStore((s) => s.settings?.playSound ?? true)
  const chaptersPaneWidth = useLayoutStore((s) => s.layout.chaptersPaneWidth)

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

  const mediaMeta = mediaMetaLine(sidecar)

  const mediaUrl = item.filename && mediaBase
    ? `${mediaBase}/${encodeURIComponent(item.filename)}`
    : null

  useEnforcedMute(videoRef, !playSound, mediaUrl)

  function seek(seconds: number) {
    const v = videoRef.current
    if (!v) return
    v.currentTime = seconds
    void v.play().catch(() => {})
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

  function openRename() {
    releaseVideo(videoRef.current)
    setShowRename(true)
  }

  return (
    <div className="flex h-full">
      {/* Left column: title, video (or status panel), and action buttons stacked
          full height. Chapters sit alongside as a sibling so they run the whole
          height of the pane, not just the space under the title. Padding lives on
          each column (not the row) so the chapters divider can span edge to edge.
          Horizontal padding lives on each row (not the column) so the title and
          button borders span full width and meet the side dividers. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col py-4">
        <div className="shrink-0 border-b border-zinc-700 px-4 pb-3">
          {/* Title is always shown; clicking it discloses the optional metadata.
              The chevron sits in a fixed-width slot so the title's wrapped lines
              and the disclosed metadata both align under the title text. */}
          <button
            onClick={() => setInfoOpen((v) => !v)}
            aria-expanded={infoOpen}
            className="group flex w-full text-left"
          >
            <span className="flex h-7 w-5 shrink-0 items-center justify-center">
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                className={
                  'text-zinc-400 transition-transform group-hover:text-zinc-300 ' +
                  (infoOpen ? 'rotate-90' : '')
                }
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </span>
            <h2 className="min-w-0 flex-1 text-lg font-medium leading-7 group-hover:text-zinc-300">
              {item.title ?? item.sourceUrl}
            </h2>
          </button>
          {infoOpen && (
            <div className="mt-1 space-y-1 pl-5">
              <p className="text-xs text-zinc-300">
                {item.uploader ?? 'unknown uploader'}
                {item.durationSeconds != null && ` · ${formatTime(item.durationSeconds)}`}
                {' · '}
                {item.state === 'playlist' ? 'playlist or channel' : item.state}
                {item.archivedAtUtc && ' · archived'}
              </p>
              {mediaMeta && <p className="text-xs text-zinc-300">{mediaMeta}</p>}
              <p className="truncate text-xs text-zinc-300">
                <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="hover:text-zinc-300">
                  {item.sourceUrl}
                </a>
              </p>
              {item.slug && (
                <p className="text-xs text-zinc-300">
                  Slug: <span className="text-zinc-300">{item.slug}</span>
                </p>
              )}
            </div>
          )}
        </div>

        {/* For a downloaded tape the video fills the height between the title and
            the buttons. Other states show a single status panel here. */}
        {item.state === 'downloaded' ? (
          <div className="mt-3 flex min-h-[200px] min-w-0 flex-1 items-center justify-center px-4">
            {mediaUrl && !showRename && (
              <Player ref={videoRef} src={mediaUrl} poster={item.thumbnailUrl ?? undefined} autoPlay={autoplay} muted={!playSound} />
            )}
          </div>
        ) : item.state === 'playlist' ? (
          <CaptionedPanel kind="warning" caption="This is a playlist or channel">
            <div className="p-5">
              <p className="text-sm leading-relaxed text-zinc-300">
                TapeBox adds one video at a time here. To choose which videos to take
                from this, open the scanner — it lists every video so you can pick.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <ActionButton onClick={() => onOpenPlaylist(item.sourceUrl)}>Open scanner</ActionButton>
                <ActionButton onClick={copyUrl}>{copied ? 'Copied' : 'Copy URL'}</ActionButton>
              </div>
            </div>
          </CaptionedPanel>
        ) : item.state === 'failed' ? (
          <CaptionedPanel kind="error" caption="Download failed" fill>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 text-xs text-zinc-300">
              {item.lastError ?? 'No details available.'}
            </pre>
          </CaptionedPanel>
        ) : item.state === 'paused' ? (
          <div className="mx-4 mt-3 rounded border border-zinc-700 bg-zinc-900/40 p-4 text-sm text-zinc-300">
            Paused. Click Resume below to continue.
          </div>
        ) : (
          <div className="mx-4 mt-3 space-y-2 rounded border border-zinc-700 bg-zinc-900/40 p-4 text-sm">
            <div className="text-zinc-300">
              {progress
                ? progress.phase === 'downloading'
                  ? `Downloading… ${progress.percent.toFixed(0)}%`
                  : 'Probing…'
                : 'Waiting in queue…'}
            </div>
            {progress &&
              (progress.phase === 'downloading' && progress.percent > 0 ? (
                <ProgressBar percent={progress.percent} />
              ) : (
                <IndeterminateBar />
              ))}
          </div>
        )}

        <div className="mt-3 flex shrink-0 flex-wrap gap-2 border-t border-zinc-700 px-4 pt-3">
          {(item.state === 'queued' || item.state === 'probing' || item.state === 'downloading') && (
            <ActionButton onClick={cancel}>Cancel</ActionButton>
          )}
          {item.state === 'failed' && (
            <ActionButton onClick={retry}>Retry</ActionButton>
          )}
          {item.state === 'paused' && (
            <ActionButton onClick={retry}>Resume</ActionButton>
          )}
          {item.state === 'downloaded' && (
            <>
              <ActionButton onClick={() => void ipcInvoke('library:playExternal', { itemId: item.id })}>Open in player</ActionButton>
              <ActionButton onClick={() => void ipcInvoke('library:reveal', { itemId: item.id })}>Show in folder</ActionButton>
              <ActionButton onClick={() => setShowExport(true)}>Export</ActionButton>
              <ActionButton onClick={openRename}>Rename</ActionButton>
              {item.archivedAtUtc ? (
                <>
                  <MoveToBoxButton item={item} />
                  <ActionButton onClick={unarchive}>Move to Shelf</ActionButton>
                </>
              ) : (
                <ActionButton onClick={archive}>Archive</ActionButton>
              )}
            </>
          )}
          <ActionButton onClick={() => onRequestRemove(item)} danger>Remove</ActionButton>
        </div>
      </div>

      {/* Chapters: full-height side pane, divided from the video by a border like
          the left pane's. Its own padding keeps the divider running edge to edge. */}
      {item.state === 'downloaded' && (chapters.length > 0 || sidecarError) && (
        <aside
          style={{ width: chaptersPaneWidth }}
          className="relative flex shrink-0 flex-col border-l border-zinc-700 p-4"
        >
          <ResizeHandle
            edge="left"
            size={chaptersPaneWidth}
            min={200}
            max={720}
            onResize={(w) => patchLayout({ chaptersPaneWidth: w }, false)}
            onCommit={(w) => patchLayout({ chaptersPaneWidth: w }, true)}
          />
          <h3 className="mb-2 shrink-0 text-sm font-medium text-zinc-300">Chapters</h3>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {sidecarError
              ? <p className="text-xs text-red-300">{sidecarError}</p>
              : <ChapterList chapters={chapters} onSeek={seek} />}
          </div>
        </aside>
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

/** A one-line technical summary: resolution · fps · codecs · ext · size. Prefers
 *  the ffmpeg-probed `tapebox.media` block, falling back to yt-dlp's own fields. */
function mediaMetaLine(sidecar: SidecarRaw | null): string | null {
  if (!sidecar) return null
  const media = (sidecar.tapebox?.['media'] ?? null) as Record<string, unknown> | null
  const pick = (key: string): unknown => media?.[key] ?? sidecar[key]
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

  const parts: string[] = []
  const w = num(pick('width'))
  const h = num(pick('height'))
  if (w !== null && h !== null) parts.push(`${w}×${h}`)
  const fps = num(pick('fps'))
  if (fps !== null) parts.push(`${Math.round(fps)} fps`)
  const codecs = [pick('vcodec'), pick('acodec')]
    .filter((c): c is string => typeof c === 'string' && c.length > 0 && c !== 'none')
    .map((c) => c.split('.')[0])
  if (codecs.length > 0) parts.push(codecs.join(' / '))
  const ext = sidecar['ext']
  if (typeof ext === 'string' && ext) parts.push(ext)
  const size = num(sidecar['filesize']) ?? num(sidecar['filesize_approx'])
  if (size !== null) parts.push(formatBytes(size))
  return parts.length > 0 ? parts.join(' · ') : null
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
