import type { Item } from './domain'
import type { Settings } from './settings'

/**
 * Request/response contract for ipcMain.handle / ipcRenderer.invoke channels.
 * Channel names use 'domain:action' convention.
 *
 * This file is type-only and pure — safe to import from main, preload, and
 * renderer. The renderer's typed client (preload contextBridge) and the main
 * registrar both derive from this single source of truth.
 */
export type IpcCalls = {
  // ── Downloads (URL → Item lifecycle) ─────────────────────────────────────
  'downloads:add':         { req: { url: string };                  res: Item[] }   // 1+ Items: playlist may expand
  'downloads:addBulk':     { req: { urls: string[] };               res: Item[] }
  'downloads:cancel':      { req: { itemId: string };               res: void }
  'downloads:retry':       { req: { itemId: string };               res: void }

  // ── Library ──────────────────────────────────────────────────────────────
  'library:list':            { req: undefined;                                       res: Item[] }
  'library:remove':          { req: { itemIds: string[]; deleteFiles: boolean };     res: void }
  'library:renameToSlug':    { req: { itemId: string; slug: string };                res: Item }
  'library:import':          { req: { mediaPaths: string[] };                        res: ImportResult }
  'library:archive':         { req: { itemIds: string[] };                           res: void }
  'library:unarchive':       { req: { itemIds: string[] };                           res: void }
  'library:getSidecar':      { req: { itemId: string };                              res: SidecarRaw }

  // ── Export (outside the box) ─────────────────────────────────────────────
  'export:audio': {
    req: {
      itemId: string
      destinationDir: string
      mode: 'whole' | 'perChapter'
      codec: 'copy' | 'mp3' | 'flac'
      filenameTemplate?: string
    }
    res: { writtenPaths: string[] }
  }

  // ── AI ───────────────────────────────────────────────────────────────────
  'ai:generateSlug':       { req: { itemId: string };               res: { slug: string } }

  // ── Settings ─────────────────────────────────────────────────────────────
  'settings:get':          { req: undefined;                         res: Settings }
  'settings:update':       { req: Partial<Settings>;                 res: Settings }
  'settings:setApiKey':    { req: { profileId: string; apiKey: string }; res: void }
  'settings:clearApiKey':  { req: { profileId: string };             res: void }

  // ── Binaries ─────────────────────────────────────────────────────────────
  'binaries:status':       { req: undefined;                         res: BinaryStatus[] }
  'binaries:update':       { req: { name: BinaryName };              res: void }
  'binaries:checkUpdates': { req: undefined;                         res: BinaryStatus[] }

  // ── Enumeration (playlist/channel pre-add) ───────────────────────────────
  // Split into detect + start so the renderer can attach event subscribers
  // BEFORE any streaming begins. Race-free: enum:detect is pure probe, and
  // events for enum:start only fire after subscribers are in place.
  'enum:detect':           { req: { url: string };                   res: EnumDetectResult }
  'enum:start':            { req: { url: string };                   res: { sessionId: string } }
  'enum:cancel':           { req: { sessionId: string };             res: void }

  // ── Native dialogs ───────────────────────────────────────────────────────
  'dialog:pickDirectory':  { req: { title?: string };                res: string | null }

  // ── Runtime info ─────────────────────────────────────────────────────────
  // Read-only facts about the current process: platform, arch, whether the
  // OS keychain is available for safeStorage. Renderer uses this to gate UI
  // affordances (e.g., hide "Save API key" when keychain unavailable).
  'app:runtimeInfo':       { req: undefined;                         res: RuntimeInfo }
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
  imported: Item[]
  rejected: { path: string; reason: string }[]
}

export type EnumDetectResult = {
  kind: 'single' | 'multi'
  sourceTitle: string | null
}

export type RuntimeInfo = {
  platform: NodeJS.Platform
  arch: string
  encryptionAvailable: boolean
}

export type EnumEntry = {
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
  'items:added':       Item[]
  'items:updated':     Item
  'items:progress':    {
    itemId: string
    phase: 'probing' | 'downloading'
    percent: number
    speedBps?: number
    etaSec?: number
  }
  'items:completed':   { itemId: string }
  'items:failed':      { itemId: string; error: string }
  'items:removed':     { itemIds: string[] }

  'enum:entry':        { sessionId: string; entry: EnumEntry }
  'enum:done':         { sessionId: string; totalCount: number }
  'enum:error':        { sessionId: string; error: string }

  'binaries:progress':        { name: BinaryName; percent: number; phase: 'download' | 'verify' | 'install' }
  'binaries:ready':           { name: BinaryName; version: string }
}
