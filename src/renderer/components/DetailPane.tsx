import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { z } from 'zod'
import type { Tape, TapeState } from '@shared/domain'
import type { SidecarRaw } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import { useTapesStore, type ProgressEntry } from '@renderer/store/tapes'
import { useDownloadLogStore, type LogEntry } from '@renderer/store/downloadLog'
import { useMediaStore } from '@renderer/store/media'
import { useToastStore } from '@renderer/store/toast'
import { useSettingsStore } from '@renderer/store/settings'
import { useLayoutStore, patchLayout } from '@renderer/store/layout'
import { releaseVideo } from '@renderer/lib/video'
import { useEnforcedMute } from '@renderer/lib/useEnforcedMute'
import { formatBytes, formatSpeed, formatTime } from '@renderer/lib/format'
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
  tape,
  videoRef,
  onRequestRemove,
  onScanPage,
}: {
  tape: Tape
  videoRef: RefObject<HTMLVideoElement | null>
  onRequestRemove: (tape: Tape) => void
  onScanPage: (url: string) => void
}) {
  const [sidecar, setSidecar] = useState<SidecarRaw | null>(null)
  const [sidecarError, setSidecarError] = useState<string | null>(null)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [showRename, setShowRename] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const progress = useTapesStore((s) => s.progress[tape.id])
  const logEntries = useDownloadLogStore((s) => s.entries[tape.id]) ?? NO_ENTRIES
  const mediaBase = useMediaStore((s) => s.baseUrl)
  const autoplay = useSettingsStore((s) => s.settings?.autoplay ?? true)
  const playSound = useSettingsStore((s) => s.settings?.playSound ?? true)
  const chaptersPaneWidth = useLayoutStore((s) => s.layout.chaptersPaneWidth)

  useEffect(() => {
    setSidecar(null)
    setSidecarError(null)
    if (tape.state !== 'downloaded') return
    let cancelled = false
    ipcInvoke('library:getSidecar', { tapeId: tape.id })
      .then((s) => { if (!cancelled) setSidecar(s) })
      .catch((err) => { if (!cancelled) setSidecarError(String(err)) })
    return () => { cancelled = true }
  }, [tape.id, tape.state, tape.sidecarFilename])

  const chapters: Chapter[] = (() => {
    const raw = sidecar?.chapters
    if (!Array.isArray(raw)) return []
    const parsed = z.array(SidecarChapterSchema).safeParse(raw)
    return parsed.success ? parsed.data : []
  })()

  const mediaMeta = mediaMetaLine(sidecar)

  const mediaUrl = tape.filename && mediaBase
    ? `${mediaBase}/${encodeURIComponent(tape.filename)}`
    : null

  // A new source clears any prior playback error (and a fresh load may succeed).
  useEffect(() => { setPlaybackError(null) }, [mediaUrl])

  useEnforcedMute(videoRef, !playSound, mediaUrl)

  function seek(seconds: number) {
    const v = videoRef.current
    if (!v) return
    v.currentTime = seconds
    void v.play().catch(() => {})
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(tape.sourceUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable; nothing actionable to show */ }
  }

  async function archive()   { await ipcInvoke('library:archive',   { tapeIds: [tape.id] }) }
  async function unarchive() { await ipcInvoke('library:unarchive', { tapeIds: [tape.id] }) }
  async function cancel()    { await ipcInvoke('downloads:cancel',  { tapeId: tape.id }) }
  async function retry()     { await ipcInvoke('downloads:retry',   { tapeId: tape.id }) }

  async function refreshMetadata() {
    setRefreshing(true)
    try {
      await ipcInvoke('library:refreshMetadata', { tapeId: tape.id })
      useToastStore.getState().notify('Metadata refreshed.', 'info')
    } catch (err) {
      useToastStore.getState().notify(`Refresh failed: ${String(err)}`, 'error')
    } finally {
      setRefreshing(false)
    }
  }

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
          {/* One consistent header for every tape state: a chevron toggles the
              optional details, the heading is the title (or the URL when no title
              exists yet), a one-line status reflects live state, and Open/Copy
              act on the source URL identically for all tapes. Detail rows below
              the fold appear only when their field is present — no filler. */}
          <div className="flex items-start gap-1">
            <button
              onClick={() => setInfoOpen((v) => !v)}
              aria-expanded={infoOpen}
              aria-label={infoOpen ? 'Hide details' : 'Show details'}
              className="group flex h-7 w-5 shrink-0 items-center justify-center"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                className={
                  'text-zinc-400 transition-transform group-hover:text-zinc-200 ' +
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
            </button>
            <div className="min-w-0 flex-1">
              <h2 className="select-text break-words text-lg font-medium leading-7">
                {tape.title ?? tape.sourceUrl}
              </h2>
              <p className="mt-0.5 text-xs text-zinc-400">{headerStatus(tape, progress)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1 pt-0.5">
              <a
                href={tape.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
              >
                Open
              </a>
              <button
                onClick={copyUrl}
                className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
              >
                {copied ? 'Copied' : 'Copy URL'}
              </button>
            </div>
          </div>
          {infoOpen && (
            <dl className="mt-2 space-y-1 pl-6 text-xs text-zinc-300">
              {tape.uploader && <DetailRow label="Uploader">{tape.uploader}</DetailRow>}
              {tape.durationSeconds != null && (
                <DetailRow label="Duration">{formatTime(tape.durationSeconds)}</DetailRow>
              )}
              {mediaMeta && <DetailRow label="Media">{mediaMeta}</DetailRow>}
              {/* The source URL is the heading already when there's no title, so
                  only show it here (as a link) when a title occupies the heading. */}
              {tape.title && (
                <DetailRow label="Source">
                  <a
                    href={tape.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="select-text break-all hover:text-zinc-100"
                  >
                    {tape.sourceUrl}
                  </a>
                </DetailRow>
              )}
              {tape.slug && (
                <DetailRow label="Slug">
                  <span className="select-text">{tape.slug}</span>
                </DetailRow>
              )}
            </dl>
          )}
        </div>

        {/* For a downloaded tape the video fills the height between the title and
            the buttons. Other states show a single status panel here. */}
        {tape.state === 'downloaded' ? (
          <div className="mt-3 flex min-h-[200px] min-w-0 flex-1 items-center justify-center px-4">
            {playbackError ? (
              <div className="w-full rounded border border-red-900 bg-red-950/30 p-4">
                <p className="text-sm font-medium text-red-300">This tape couldn&apos;t be played</p>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-zinc-300">
                  {playbackError}
                </pre>
                <p className="mt-2 text-xs text-zinc-400">
                  Try “Open in player” below for the system player, or reveal the session log from the menu for the full record.
                </p>
              </div>
            ) : mediaUrl && !showRename ? (
              <Player
                ref={videoRef}
                src={mediaUrl}
                poster={tape.thumbnailUrl ?? undefined}
                autoPlay={autoplay}
                muted={!playSound}
                onError={(v) => setPlaybackError(describeMediaError(v))}
              />
            ) : null}
          </div>
        ) : tape.state === 'listing' ? (
          <CaptionedPanel kind="warning" caption="This URL is a page of videos">
            <div className="p-5">
              <p className="text-sm leading-relaxed text-zinc-300">
                TapeBox adds one video at a time. Scan this page to list its videos
                and pick the ones to add.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <ActionButton onClick={() => onScanPage(tape.sourceUrl)}>Scan page</ActionButton>
                <ActionButton onClick={copyUrl}>{copied ? 'Copied' : 'Copy URL'}</ActionButton>
              </div>
            </div>
          </CaptionedPanel>
        ) : tape.state === 'paused' ? (
          <div className="mx-4 mt-3 rounded border border-zinc-700 bg-zinc-900/40 p-4 text-sm text-zinc-300">
            Paused. Click Resume below to continue.
          </div>
        ) : (
          <DownloadLogPanel tape={tape} progress={progress} entries={logEntries} />
        )}

        <div className="mt-3 flex shrink-0 flex-wrap gap-2 border-t border-zinc-700 px-4 pt-3">
          {(tape.state === 'queued' || tape.state === 'probing' || tape.state === 'downloading') && (
            <ActionButton onClick={cancel}>Cancel</ActionButton>
          )}
          {tape.state === 'failed' && (
            <ActionButton onClick={retry}>Retry</ActionButton>
          )}
          {tape.state === 'paused' && (
            <ActionButton onClick={retry}>Resume</ActionButton>
          )}
          {tape.state === 'downloaded' && (
            <>
              <ActionButton onClick={() => void ipcInvoke('library:playExternal', { tapeId: tape.id })}>Open in player</ActionButton>
              <ActionButton onClick={() => void ipcInvoke('library:reveal', { tapeId: tape.id })}>Show in folder</ActionButton>
              <ActionButton onClick={() => setShowExport(true)}>Export</ActionButton>
              <ActionButton onClick={openRename}>Rename</ActionButton>
              <ActionButton onClick={refreshMetadata} disabled={refreshing}>
                {refreshing ? 'Refreshing…' : 'Refresh metadata'}
              </ActionButton>
              {tape.archivedAtUtc ? (
                <>
                  <MoveToBoxButton tape={tape} />
                  <ActionButton onClick={unarchive}>Move to Inbox</ActionButton>
                </>
              ) : (
                <ActionButton onClick={archive}>Archive</ActionButton>
              )}
            </>
          )}
          <ActionButton onClick={() => onRequestRemove(tape)} danger>Remove</ActionButton>
        </div>
      </div>

      {/* Chapters: full-height side pane, divided from the video by a border like
          the left pane's. Its own padding keeps the divider running edge to edge. */}
      {tape.state === 'downloaded' && (chapters.length > 0 || sidecarError) && (
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
        <RenameModal tape={tape} onClose={() => setShowRename(false)} />
      )}
      {showExport && (
        <ExportModal tape={tape} onClose={() => setShowExport(false)} />
      )}
    </div>
  )
}

/** Stable empty array so a tape with no buffered log doesn't churn the selector. */
const NO_ENTRIES: LogEntry[] = []

const STATE_LABEL: Record<TapeState, string> = {
  queued: 'Queued',
  probing: 'Fetching info…',
  ready: 'Ready to download',
  downloading: 'Downloading…',
  downloaded: 'In library',
  failed: 'Failed',
  paused: 'Paused',
  listing: 'Video list page',
}

const WORKING_PLACEHOLDER: Partial<Record<TapeState, string>> = {
  queued: 'Waiting for a free download slot…',
  probing: 'Fetching video info…',
  ready: 'Starting download…',
  downloading: 'Starting download…',
}

/** The one-line status under the heading: live progress when downloading,
 *  otherwise a clean state label, with an Archived suffix when archived. */
function headerStatus(tape: Tape, progress: ProgressEntry | undefined): string {
  let base: string
  if (progress?.phase === 'downloading') {
    base = `Downloading ${progress.percent.toFixed(0)}%`
    if (progress.speedBps) base += ` · ${formatSpeed(progress.speedBps)}`
  } else if (progress?.phase === 'probing') {
    base = 'Fetching info…'
  } else {
    base = STATE_LABEL[tape.state]
  }
  return tape.archivedAtUtc ? `${base} · Archived` : base
}

/** A label/value row in the disclosed detail list. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

/**
 * The body shown while a tape is queued/probing/downloading or after it failed:
 * yt-dlp's live output, newest line first. On failure the error sits at the top
 * (the store prepends it); after an app restart the live buffer is empty, so a
 * failed tape falls back to its persisted lastError. A successful download flips
 * the tape to 'downloaded' and the player replaces this panel.
 */
function DownloadLogPanel({
  tape,
  progress,
  entries,
}: {
  tape: Tape
  progress: ProgressEntry | undefined
  entries: LogEntry[]
}) {
  const failed = tape.state === 'failed'
  const downloading = progress?.phase === 'downloading'
  const fallback =
    entries.length === 0 && failed ? (tape.lastError ?? 'No details available.') : null

  return (
    <CaptionedPanel
      kind={failed ? 'error' : 'neutral'}
      caption={failed ? 'Download failed' : 'Working…'}
      fill
    >
      {downloading && (
        <div className="shrink-0 px-3 pt-3">
          {progress.percent > 0 ? <ProgressBar percent={progress.percent} /> : <IndeterminateBar />}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs">
        {fallback != null ? (
          <pre className="whitespace-pre-wrap break-words text-zinc-300">{fallback}</pre>
        ) : entries.length > 0 ? (
          <ul className="space-y-0.5">
            {entries.map((e, i) => (
              <li
                key={i}
                className={
                  'whitespace-pre-wrap break-words ' +
                  (e.kind === 'error' ? 'text-red-300' : 'text-zinc-400')
                }
              >
                {e.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-zinc-500">{WORKING_PLACEHOLDER[tape.state] ?? 'Working…'}</p>
        )}
      </div>
    </CaptionedPanel>
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
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void | Promise<void>
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        'rounded border px-3 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-50 ' +
        (danger
          ? 'border-red-900 text-red-300 hover:border-red-700 hover:bg-red-950/40'
          : 'border-zinc-700 text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800/60')
      }
    >
      {children}
    </button>
  )
}

/** Everything the <video> element can report about a failed playback, as plain
 *  text. There's no richer source, so the app surfaces this verbatim. */
function describeMediaError(v: HTMLVideoElement): string {
  const labels: Record<number, string> = {
    1: 'Playback aborted',
    2: 'Network error while loading the file',
    3: 'Decode error — the file may be corrupt or use an unsupported encoding',
    4: 'Source not supported — the container or codec can’t be played here',
  }
  const lines: string[] = []
  const err = v.error
  if (err) {
    lines.push(`${labels[err.code] ?? 'Unknown media error'} (code ${err.code})`)
    if (err.message) lines.push(err.message)
  } else {
    lines.push('The player reported an error with no further detail.')
  }
  lines.push(`source: ${v.currentSrc || v.src}`)
  lines.push(`networkState: ${v.networkState} · readyState: ${v.readyState}`)
  return lines.join('\n')
}
