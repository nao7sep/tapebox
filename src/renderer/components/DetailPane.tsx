import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { z } from 'zod'
import type { Tape, TapeState } from '@shared/domain'
import type { SidecarRaw } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import { useTapesStore, type ProgressEntry } from '@renderer/store/tapes'
import { useDownloadLogStore, type LogEntry } from '@renderer/store/downloadLog'
import { useMediaStore } from '@renderer/store/media'
import { useSettingsStore } from '@renderer/store/settings'
import { useLayoutStore, patchLayout } from '@renderer/store/layout'
import { releaseVideo } from '@renderer/lib/video'
import { useEnforcedMute } from '@renderer/lib/useEnforcedMute'
import { useKeepAwake } from '@renderer/lib/useKeepAwake'
import { useVolume } from '@renderer/lib/useVolume'
import { formatBytes, formatSpeed, formatTime } from '@renderer/lib/format'
import { tapeStatusLabel, isProcessing } from '@renderer/lib/tapeStatus'
import { IndeterminateBar, ProgressBar } from './Progress'
import { Player } from './Player'
import { ChapterList } from './ChapterList'
import { RenameModal } from './RenameModal'
import { RefreshMetadataModal } from './RefreshMetadataModal'
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
  const [showRefresh, setShowRefresh] = useState(false)
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
  const description = (() => {
    const d = sidecar?.['description']
    return typeof d === 'string' && d.trim() ? d.trim() : null
  })()

  // Downloaded tapes lead with the media line (always visible) and disclose
  // source / file / uploader / description; other states keep the status sub-line
  // and the older row set. The header expands only when a disclosed row exists.
  const downloaded = tape.state === 'downloaded'
  const expandable = downloaded
    ? !!tape.title || !!tape.filename || !!tape.uploader || !!description
    : !!tape.uploader || tape.durationSeconds != null || !!tape.title || !!tape.slug

  const mediaUrl = tape.filename && mediaBase
    ? `${mediaBase}/${encodeURIComponent(tape.filename)}`
    : null

  // Local poster, served from the same loopback media server as the video.
  const posterSrc = tape.thumbnailFilename && mediaBase
    ? `${mediaBase}/${encodeURIComponent(tape.thumbnailFilename)}`
    : undefined

  // A new source clears any prior playback error (and a fresh load may succeed).
  useEffect(() => { setPlaybackError(null) }, [mediaUrl])

  useEnforcedMute(videoRef, !playSound, mediaUrl)

  // Key on whether the <video> is actually mounted (a rename modal or playback
  // error replaces it), so the wake-lock hook re-attaches its listeners when the
  // player reappears rather than going silent until the next tape.
  const playerSrc = tape.state === 'downloaded' && !showRename && !playbackError ? mediaUrl : null
  useKeepAwake(videoRef, playerSrc)
  useVolume(videoRef, playerSrc)

  function seek(seconds: number) {
    const v = videoRef.current
    if (!v) return
    v.currentTime = seconds
    // play() rejects as normal control flow (autoplay policy, or a play
    // interrupted by a new load) — an expected branch, not a logged incident.
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
          {/* The header is purely informative — heading, live status, and the
              optional details below the fold. Every operation lives in the
              button row, so the header carries no actions. The chevron appears
              only when there is something to expand. */}
          <div className="flex items-start gap-1">
            {expandable ? (
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
            ) : (
              <span className="h-7 w-5 shrink-0" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <h2 className="select-text break-words text-lg font-medium leading-7">
                {tape.title ?? tape.sourceUrl}
              </h2>
              {/* Always visible: the media line for a downloaded tape (its "status"
                  is just "In library", which says nothing), otherwise the status. */}
              <p className="mt-0.5 truncate text-xs text-zinc-400">
                {downloaded && mediaMeta ? mediaMeta : headerStatus(tape, progress)}
              </p>
            </div>
          </div>
          {expandable && infoOpen && (downloaded ? (
            // Unlabeled by design: a URL, a filename (with extension), and the
            // uploader sitting just above the description are each self-evident from
            // their shape and position, so labels would only add noise. Order is
            // outside-in: source → file → uploader → (rule) → description.
            <div className="mt-2 pl-6 text-xs text-zinc-300">
              {/* Related lines, tight: 4px apart (space-y-1). */}
              <div className="space-y-1">
                {tape.title && (
                  <a
                    href={tape.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block select-text break-all hover:text-zinc-100"
                  >
                    {tape.sourceUrl}
                  </a>
                )}
                {tape.filename && <div className="select-text break-all">{tape.filename}</div>}
                {tape.uploader && <div className="select-text break-words">{tape.uploader}</div>}
              </div>
              {/* Section break: the rule is the end of the lines above, so it gets
                  equal room on both sides — 8px (2× the line gap) above the rule
                  from the uploader, and 8px below it before the description. */}
              {description && (
                <div className="mt-2 border-t border-zinc-700 pt-2">
                  <div className="max-h-40 select-text overflow-y-auto whitespace-pre-wrap break-words">
                    {description}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <dl className="mt-2 space-y-1 pl-6 text-xs text-zinc-300">
              {tape.uploader && <DetailRow label="Uploader">{tape.uploader}</DetailRow>}
              {tape.durationSeconds != null && (
                <DetailRow label="Duration">{formatTime(tape.durationSeconds)}</DetailRow>
              )}
              {/* Source is the heading already when there's no title, so only show it
                  here (as a link) when a title occupies the heading. */}
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
          ))}
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
                posterSrc={posterSrc}
                autoPlay={autoplay}
                muted={!playSound}
                onError={(v) => setPlaybackError(describeMediaError(v))}
              />
            ) : null}
          </div>
        ) : tape.state === 'listing' ? (
          <CaptionedPanel kind="info" caption="This page lists several videos">
            <p className="p-5 text-sm leading-relaxed text-zinc-300">
              TapeBox adds one video at a time. Use <strong>Scan page</strong> below
              to see its videos and pick which to add.
            </p>
          </CaptionedPanel>
        ) : tape.state === 'paused' ? (
          <CaptionedPanel kind="warning" caption="Paused">
            <p className="p-5 text-sm leading-relaxed text-zinc-300">
              Auto-start is off, so it won't download until you resume it.
            </p>
          </CaptionedPanel>
        ) : (
          <DownloadLogPanel tape={tape} progress={progress} entries={logEntries} />
        )}

        {/* All operations live here, in a consistent order for every state:
            the state's primary action first, then the downloaded-tape actions
            grouped use → housekeep (refresh → rename → export) → archive, then
            the source-link reference actions that apply to any tape, and finally
            the destructive Remove, set apart on the right. */}
        <div className="mt-auto flex shrink-0 flex-wrap items-center gap-2 border-t border-zinc-700 px-4 pt-3">
          {/* Primary: re-engage / resolve the current state. */}
          {(tape.state === 'queued' || tape.state === 'probing' || tape.state === 'downloading') && (
            <ActionButton onClick={cancel}>Cancel</ActionButton>
          )}
          {tape.state === 'failed' && (
            <ActionButton onClick={retry}>Retry</ActionButton>
          )}
          {tape.state === 'paused' && (
            <ActionButton onClick={retry}>Resume</ActionButton>
          )}
          {tape.state === 'listing' && (
            <ActionButton onClick={() => onScanPage(tape.sourceUrl)}>Scan page</ActionButton>
          )}
          {tape.state === 'downloaded' && (
            <>
              {/* Use the file. */}
              <ActionButton onClick={() => void ipcInvoke('library:playExternal', { tapeId: tape.id })}>Open in player</ActionButton>
              <ActionButton onClick={() => void ipcInvoke('library:reveal', { tapeId: tape.id })}>Show in folder</ActionButton>
              {/* Housekeep: refresh first (rename and export both benefit from
                  up-to-date metadata), then rename, then export. */}
              <ActionButton onClick={() => setShowRefresh(true)}>Refresh metadata</ActionButton>
              <ActionButton onClick={openRename}>Rename</ActionButton>
              <ActionButton onClick={() => setShowExport(true)}>Export</ActionButton>
              {/* Organize, once the work is done. */}
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
          {/* Source link — available for any tape, in every state. */}
          <ActionButton onClick={() => { window.open(tape.sourceUrl, '_blank', 'noopener') }}>Open URL</ActionButton>
          <ActionButton onClick={copyUrl}>{copied ? 'Copied' : 'Copy URL'}</ActionButton>
          {/* Destructive: always last, pushed to the far right. */}
          <ActionButton onClick={() => onRequestRemove(tape)} danger className="ml-auto">Remove</ActionButton>
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

      {showRefresh && (
        <RefreshMetadataModal tape={tape} onClose={() => setShowRefresh(false)} />
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

const WORKING_PLACEHOLDER: Partial<Record<TapeState, string>> = {
  queued: 'Waiting for a free download slot…',
  probing: 'Fetching video info…',
  ready: 'Starting download…',
  downloading: 'Starting download…',
}

/** The one-line status under the heading: the shared status label, plus the live
 *  download speed when downloading and an Archived suffix when archived. */
function headerStatus(tape: Tape, progress: ProgressEntry | undefined): string {
  let base = tapeStatusLabel(tape, progress)
  if (progress?.phase === 'downloading' && progress.speedBps) {
    base += ` · ${formatSpeed(progress.speedBps)}`
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
      caption={failed ? 'Download failed' : tape.state === 'queued' ? 'Queued' : 'Working…'}
      fill
    >
      {isProcessing(tape.state) && (
        <div className="shrink-0 px-3 pt-3">
          {downloading && progress.percent > 0 ? (
            <ProgressBar percent={progress.percent} />
          ) : (
            <IndeterminateBar />
          )}
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

/** A one-line technical summary, outside-in: container · codec · frame size · fps
 *  · duration · size. Prefers the ffmpeg-probed `tapebox.media` block, falling
 *  back to yt-dlp's own fields. */
function mediaMetaLine(sidecar: SidecarRaw | null): string | null {
  if (!sidecar) return null
  const media = (sidecar.tapebox?.['media'] ?? null) as Record<string, unknown> | null
  const pick = (key: string): unknown => media?.[key] ?? sidecar[key]
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

  const parts: string[] = []
  const ext = sidecar['ext']
  if (typeof ext === 'string' && ext) parts.push(ext)
  const codecs = [pick('vcodec'), pick('acodec')]
    .filter((c): c is string => typeof c === 'string' && c.length > 0 && c !== 'none')
    .map((c) => c.split('.')[0])
  if (codecs.length > 0) parts.push(codecs.join(' / '))
  const w = num(pick('width'))
  const h = num(pick('height'))
  if (w !== null && h !== null) parts.push(`${w}×${h}`)
  const fps = num(pick('fps'))
  if (fps !== null) parts.push(`${Math.round(fps)} fps`)
  const duration = num(pick('duration'))
  if (duration !== null) parts.push(formatTime(duration))
  const size = num(sidecar['filesize']) ?? num(sidecar['filesize_approx'])
  if (size !== null) parts.push(formatBytes(size))
  return parts.length > 0 ? parts.join(' · ') : null
}

function ActionButton({
  children,
  onClick,
  danger,
  disabled,
  className = '',
}: {
  children: React.ReactNode
  onClick: () => void | Promise<void>
  danger?: boolean
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        'rounded border px-3 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-50 ' +
        (danger
          ? 'border-red-900 text-red-300 hover:border-red-700 hover:bg-red-950/40'
          : 'border-zinc-700 text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800/60') +
        (className ? ` ${className}` : '')
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
