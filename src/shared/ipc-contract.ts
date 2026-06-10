import type { Box, Tape } from './domain'
import type { Settings } from './settings'
import type { Layout } from './layout'
import type { AudioChannels, EncodeSpeed, VideoQuality } from './export-presets'

/**
 * Request/response contract for ipcMain.handle / ipcRenderer.invoke channels.
 * Channel names use 'domain:action' convention.
 *
 * This file is type-only and pure — safe to import from main, preload, and
 * renderer. The renderer's typed client (preload contextBridge) and the main
 * registrar both derive from this single source of truth.
 *
 * Logging is the one deliberate exception: the renderer forwards log objects to
 * main over a one-way `log:write` channel (and reads main's debug state once via
 * a synchronous `log:debug-enabled`), typed by @shared/log rather than by the
 * request/response shapes below. See src/main/ipc/log.ts and src/renderer/ipc/log.ts.
 */
export type IpcCalls = {
  // ── Downloads (URL → Tape lifecycle) ─────────────────────────────────────
  'downloads:add':         { req: { url: string };                  res: Tape[] }   // 1+ Tapes: a page may expand into many
  'downloads:addBulk':     { req: { urls: string[] };               res: Tape[] }
  'downloads:cancel':      { req: { tapeId: string };               res: void }
  'downloads:retry':       { req: { tapeId: string };               res: void }

  // ── Library ──────────────────────────────────────────────────────────────
  'library:list':            { req: undefined;                                       res: Tape[] }
  'library:remove':          { req: { tapeIds: string[]; deleteFiles: boolean };     res: void }
  'library:renameToSlug':    { req: { tapeId: string; slug: string };                res: Tape }
  'library:import':          { req: { mediaPaths: string[] };                        res: ImportResult }
  'library:archive':         { req: { tapeIds: string[] };                           res: void }
  'library:unarchive':       { req: { tapeIds: string[] };                           res: void }
  'library:getSidecar':      { req: { tapeId: string };                              res: SidecarRaw }
  'library:reveal':          { req: { tapeId: string };                              res: void }
  'library:playExternal':    { req: { tapeId: string };                              res: void }
  // Deliberate, user-triggered metadata refresh, split so a re-probe can never
  // silently overwrite good data with worse: probeMetadata hits the source and
  // returns the candidate WITHOUT writing; the user reviews current-vs-new and,
  // only if they accept, applyMetadata persists exactly what they saw. Both live
  // behind an explicit button — never an automatic path.
  'library:probeMetadata':   { req: { tapeId: string };                              res: RefreshedMetadata }
  'library:applyMetadata':   { req: { tapeId: string; metadata: RefreshedMetadata }; res: Tape }

  // ── Archive organization (boxes for archived tapes) ──────────────────────
  // A box holds archived tapes in manual order; a tape is in one box or none.
  // placeTapes is the workhorse behind assign / reorder / move-between: drop
  // these tapes into `boxId` (null = Loose) before `beforeTapeId` (or at
  // the end), reindexing that box's order.
  'boxes:list':    { req: undefined;                         res: Box[] }
  'boxes:create':   { req: { name: string };                  res: Box }
  'boxes:rename':   { req: { boxId: string; name: string }; res: Box }
  'boxes:delete':   { req: { boxId: string };               res: void }
  'boxes:reorder': { req: { orderedIds: string[] };          res: void }
  'boxes:place': {
    req: { tapeIds: string[]; boxId: string | null; beforeTapeId: string | null }
    res: void
  }

  // ── Export (outside the box) ─────────────────────────────────────────────
  // Transcode/extract a tape to the user's chosen format. `presetId` selects a
  // container+codec from @shared/export-presets; the remaining fields are
  // optional quality/output knobs the chosen preset applies only where they're
  // meaningful (e.g. video knobs are ignored by an audio preset). `mode` splits
  // per-chapter or exports the whole tape. `filenameStem` names the whole-tape
  // output; `filenameTemplate` names per-chapter files (see @shared/export-filename).
  'export:media': {
    req: {
      tapeId: string
      destinationDir: string
      mode: 'whole' | 'perChapter'
      presetId: string
      audioBitrateKbps?: number | null
      audioChannels?: AudioChannels | null
      normalizeAudio?: boolean
      maxHeight?: number | null
      videoQuality?: VideoQuality | null
      encodeSpeed?: EncodeSpeed | null
      fpsCap?: number | null
      filenameStem?: string
      filenameTemplate?: string
    }
    res: { writtenPaths: string[] }
  }

  // ── AI ───────────────────────────────────────────────────────────────────
  // `include` selects which probed fields are filled into the slug prompt's
  // tokens; an unselected field substitutes to empty (so the user controls what
  // the model sees).
  'ai:generateSlug': {
    req: { tapeId: string; include: { title: boolean; uploader: boolean; description: boolean } }
    res: { slug: string }
  }

  // ── Settings ─────────────────────────────────────────────────────────────
  'settings:get':          { req: undefined;                         res: Settings }
  'settings:update':       { req: Partial<Settings>;                 res: Settings }
  'settings:setApiKey':    { req: { apiKey: string };                res: void }
  'settings:clearApiKey':  { req: undefined;                         res: void }
  'settings:hasApiKey':    { req: undefined;                         res: boolean }

  // ── Layout (window/view geometry, separate from settings) ────────────────
  'layout:get':            { req: undefined;                         res: Layout }
  'layout:update':         { req: Partial<Layout>;                   res: Layout }

  // ── Binaries ─────────────────────────────────────────────────────────────
  'binaries:status':       { req: undefined;                         res: BinaryStatus[] }
  'binaries:update':       { req: { name: BinaryName };              res: void }
  'binaries:checkUpdates': { req: undefined;                         res: BinaryStatus[] }

  // ── Scan (page scan) ──────────────────────────────────────────────
  // The Scan-a-page modal subscribes to scan:* events, then calls scan:start.
  // Returns a sessionId used to filter events and cancel the stream.
  'scan:start':            { req: { url: string };                   res: { sessionId: string } }
  'scan:cancel':           { req: { sessionId: string };             res: void }

  // ── Native dialogs ───────────────────────────────────────────────────────
  'dialog:pickDirectory':  { req: { title?: string };                res: string | null }
  'dialog:pickFiles':      { req: { title?: string };                res: string[] }

  // ── Media (loopback playback server) ─────────────────────────────────────
  // Base URL of the in-process loopback HTTP server that streams library files
  // to <video>/<audio>. Renderer appends '/<encodeURIComponent(filename)>'.
  'media:endpoint':        { req: undefined;                         res: { baseUrl: string } }

  // ── Runtime info ─────────────────────────────────────────────────────────
  // Read-only facts about the current process.
  'app:runtimeInfo':       { req: undefined;                         res: RuntimeInfo }
  // Reveal the current launch's log file in the OS file manager.
  'app:revealLog':         { req: undefined;                         res: void }
}

export type BinaryName = 'yt-dlp' | 'ffmpeg' | 'deno'

/**
 * The sidecar JSON on disk: yt-dlp's full info.json (with path fields stripped)
 * plus our 'tapebox' namespace. The yt-dlp portion is intentionally untyped —
 * it's a large, evolving surface. Only consumers that need a specific field
 * cast it locally.
 */
export type SidecarRaw = Record<string, unknown> & {
  chapters?: Array<{ start_time: number; end_time: number; title: string }>
  tapebox?: Record<string, unknown>
}

export type BinaryStatus = {
  name: BinaryName
  installedVersion: string | null
  latestKnownVersion: string | null
  lastCheckedAtUtc: string | null
  isUpdating: boolean
}

export type ImportResult = {
  imported: Tape[]
  rejected: { path: string; reason: string }[]
}

// Spelled out as a portable union (the member set of NodeJS.Platform) so this
// shared contract carries no dependency on @types/node — it is imported by the
// renderer, which is typechecked without Node types.
export type Platform =
  | "aix"
  | "android"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "openbsd"
  | "sunos"
  | "win32"
  | "cygwin"
  | "netbsd"

export type RuntimeInfo = {
  platform: Platform
  arch: string
  version: string
}

/**
 * The subset of a tape's metadata a re-probe can refresh. Identity fields
 * (sourceId, on-disk filenames) are deliberately absent — a refresh never
 * touches them. Returned by probeMetadata for review, then passed back to
 * applyMetadata verbatim if the user accepts it.
 */
export type RefreshedMetadata = {
  title: string | null
  uploader: string | null
  durationSeconds: number | null
  chapterCount: number | null
  thumbnailUrl: string | null
}

export type ScanResult = {
  sourceId: string
  sourceUrl: string
  title: string | null
  durationSeconds: number | null
  uploadDateUtc: string | null
  thumbnailUrl: string | null
  alreadyInLibrary: boolean
  unavailable: { reason: string } | null
}

/**
 * Push events main → renderer via webContents.send.
 * Renderer subscribes through preload's contextBridge wrapper.
 */
export type IpcEvents = {
  'tapes:added':       Tape[]
  'tapes:updated':     Tape
  'tapes:progress':    {
    tapeId: string
    phase: 'probing' | 'downloading'
    percent: number
    speedBps?: number
    etaSec?: number
  }
  'tapes:completed':   { tapeId: string }
  'tapes:failed':      { tapeId: string; error: string }
  'tapes:removed':     { tapeIds: string[] }
  // Live yt-dlp output for an in-progress download, one meaningful line at a
  // time, so the detail pane can show what's happening instead of a bare
  // percent. logReset clears the buffer when a fresh attempt begins.
  'tapes:log':         { tapeId: string; line: string }
  'tapes:logReset':    { tapeId: string }
  // Bulk tape update (e.g. a box reorder touches many tapes at once).
  'tapes:updatedMany': Tape[]

  // The box list changed (created / renamed / deleted / reordered).
  'boxes:changed':    Box[]

  'scan:entry':        { sessionId: string; entry: ScanResult }
  'scan:done':         { sessionId: string; totalCount: number }
  'scan:error':        { sessionId: string; error: string }

  // Live ffmpeg output during an export, one line at a time — just enough for the
  // export modal to show that work is happening (not parsed).
  'export:log':        { line: string }

  'binaries:progress':        { name: BinaryName; percent: number; phase: 'download' | 'verify' | 'install' }
  'binaries:ready':           { name: BinaryName; version: string }
}
