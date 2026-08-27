import type { Box, Tape } from './domain'
import type { Settings } from './settings'
import type { Layout } from './layout'

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
  // Rename a downloaded tape's on-disk files (media + sidecar + thumbnail) to a
  // user-chosen name — any filesystem-safe name, not just a slug. The AI can
  // suggest a slug, but the user may type a regular filename.
  'library:rename':          { req: { tapeId: string; name: string };                 res: Tape }
  // Import is sidecar-driven, but the whole user selection crosses this boundary.
  // Main can then read each sidecar and distinguish its referenced media/thumbnail
  // companions from genuinely unsupported extras without guessing in the renderer.
  'library:import':          { req: { paths: string[] };                             res: ImportResult }
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

  // ── Tape ordering (manual position within a list) ────────────────────────
  // Reindex one list (the inbox, a box, or Unboxed) to the given sequence: each id
  // gets order = its index, top first. The caller sends the list's full new order
  // after a drag; the tapes keep their archived/box membership — this is reorder,
  // not move. Used by both the inbox and the archive's within-box reorder.
  'tapes:reorder': { req: { orderedIds: string[] };          res: void }

  // ── Archive organization (boxes for archived tapes) ──────────────────────
  // A box holds archived tapes in manual order; a tape is in one box or none.
  // `boxes:place` files tapes INTO `boxId` (null = Unboxed) at the front of that
  // list, reindexing it — the cross-list move (click menu or drag onto a box).
  // Reordering WITHIN a list goes through tapes:reorder above.
  'boxes:list':    { req: undefined;                         res: Box[] }
  'boxes:create':   { req: { name: string };                  res: Box }
  'boxes:rename':   { req: { boxId: string; name: string }; res: Box }
  'boxes:delete':   { req: { boxId: string };               res: void }
  'boxes:reorder': { req: { orderedIds: string[] };          res: void }
  'boxes:place':   { req: { tapeIds: string[]; boxId: string | null }; res: void }

  // ── Export (copy out of the library) ─────────────────────────────────────
  // Copy a tape's files verbatim — media, thumbnail (if any), and sidecar — into
  // destinationDir, renaming all three to `name`. No transcoding: TapeBox is a
  // wrapper, not a converter. When deleteFromApp is true the tape is removed from
  // the library afterwards (its files trashed/deleted per the trash setting), so
  // export doubles as "move out". Returns the paths written.
  'export:files': {
    req: { tapeId: string; destinationDir: string; name: string; deleteFromApp: boolean }
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
  // The resolved default library folder (paths.library). The Settings dialog shows
  // it as the placeholder for an empty libraryDir field, so the user sees where
  // downloads land when they leave the field blank.
  'settings:defaultLibraryDir': { req: undefined;                    res: string }
  'settings:setApiKey':    { req: { apiKey: string };                res: void }
  'settings:clearApiKey':  { req: undefined;                         res: void }
  'settings:hasApiKey':    { req: undefined;                         res: boolean }

  // ── Layout (window/view geometry, separate from settings) ────────────────
  'layout:get':            { req: undefined;                         res: Layout }
  'layout:update':         { req: Partial<Layout>;                   res: Layout }

  // ── Binaries ─────────────────────────────────────────────────────────────
  'binaries:status':       { req: undefined;                         res: BinaryStatus[] }
  'binaries:update':       { req: { name: BinaryName };              res: BinaryUpdateResult }
  'binaries:cancelUpdate': { req: { name: BinaryName };              res: BinaryCancelResult }
  'binaries:checkUpdates': { req: undefined;                         res: BinaryCheckResult }
  'binaries:cancelCheck':  { req: undefined;                         res: BinaryCancelResult }

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
  // Report whether a tape is currently playing, so main can hold or release an OS
  // wake lock that keeps the machine (and display) awake during playback. Gated
  // by the keepAwakeWhilePlaying setting.
  'app:setVideoPlaying':   { req: { playing: boolean };              res: void }
}

export type BinaryName = 'yt-dlp' | 'ffmpeg' | 'deno'

export type BinaryUpdateResult =
  | { outcome: 'installed' }
  | { outcome: 'cancelled' }

export type BinaryCancelResult =
  | { outcome: 'cancel-requested' }
  | { outcome: 'not-running' }

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

/**
 * One managed binary's recorded facts on the wire — the input to deriveStatus
 * (@shared/binary-status), which the renderer calls to compute the displayed
 * lifecycle/currency/role. This carries facts, not a pre-derived state, so every
 * surface derives through the one shared rule. `present` is re-probed by main per
 * snapshot; the rest mirror the persisted BinaryEntry. Transient operation status
 * (in-flight progress, a just-failed action) is NOT here — it lives in the renderer
 * store and is layered over the derived state.
 */
export type BinaryStatus = {
  name: BinaryName
  present: boolean
  installedVersion: string | null
  latestKnownVersion: string | null
  lastCheckedAtUtc: string | null
}

export type BinaryCheckFailure = { name: BinaryName; message: string }

export type BinaryCheckResult =
  | { outcome: 'completed'; statuses: BinaryStatus[]; failures: BinaryCheckFailure[] }
  | { outcome: 'cancelled' }

export type ImportIssue = {
  path: string
  reason: string
  severity: 'information' | 'warning' | 'error'
}

export type ImportResult = {
  imported: Tape[]
  issues: ImportIssue[]
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
 * The catalog metadata a re-probe can refresh: the fields that can genuinely
 * improve from the source over time. Duration and chapter count are deliberately
 * absent — they're fixed by the downloaded file and can't change unless it's
 * replaced. Identity fields (sourceId, filenames) are never touched either.
 * Returned by probeMetadata for review, then passed back to applyMetadata if the
 * user accepts it. Title/uploader update the tape; description updates the sidecar.
 */
export type RefreshedMetadata = {
  title: string | null
  uploader: string | null
  description: string | null
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

  'binaries:progress':        { name: BinaryName; percent: number; phase: 'download' | 'verify' | 'install' }
  'binaries:ready':           { name: BinaryName; version: string }
}
