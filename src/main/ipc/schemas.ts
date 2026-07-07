import { z } from 'zod'
import type { IpcCalls } from '@shared/ipc-contract'
import { SettingsSchema } from '@shared/settings'
import { LayoutSchema } from '@shared/layout'

/**
 * Runtime request schemas for every ipcMain.handle channel — the enforcement half
 * of @shared/ipc-contract's IpcCalls, which is type-only and so pins the wire shape
 * at compile time but checks nothing at runtime. handle() (see handle.ts) parses
 * each incoming request through the matching schema before the handler runs, so a
 * malformed payload from a compromised renderer is rejected at the trust boundary
 * rather than reaching privileged main-process code.
 *
 * The `satisfies` clause makes the map self-policing: the compiler requires an entry
 * for EVERY channel and requires each schema's OUTPUT to match that channel's
 * declared `req` type. A channel added to IpcCalls without a schema — or with a
 * mismatched one — fails to compile, so no channel can silently skip validation.
 * (The schema's input type is left open: every schema validates `unknown` at the
 * boundary, and pinning input would only pick fights with zod's variance.)
 *
 * Whole objects that cross the wire reuse the existing domain validators
 * (SettingsSchema / LayoutSchema, partialled for the *:update patches). Most
 * requests are just ids and flags and carry a small inline object schema.
 */

// BinaryName mirrored as a runtime enum. The satisfies clause ties it back to the
// IpcCalls['binaries:update'] req type, so a change to BinaryName not reflected here
// fails to compile.
const BinaryNameSchema = z.enum(['yt-dlp', 'ffmpeg', 'deno'])

const RefreshedMetadataSchema = z.object({
  title: z.string().nullable(),
  uploader: z.string().nullable(),
  description: z.string().nullable(),
})

export const ipcRequestSchemas = {
  // ── Downloads ──────────────────────────────────────────────────────────────
  'downloads:add':         z.object({ url: z.string() }),
  'downloads:addBulk':     z.object({ urls: z.array(z.string()) }),
  'downloads:cancel':      z.object({ tapeId: z.string() }),
  'downloads:retry':       z.object({ tapeId: z.string() }),

  // ── Library ──────────────────────────────────────────────────────────────
  'library:list':          z.undefined(),
  'library:remove':        z.object({ tapeIds: z.array(z.string()), deleteFiles: z.boolean() }),
  'library:rename':        z.object({ tapeId: z.string(), name: z.string() }),
  'library:import':        z.object({ sidecarPaths: z.array(z.string()) }),
  'library:archive':       z.object({ tapeIds: z.array(z.string()) }),
  'library:unarchive':     z.object({ tapeIds: z.array(z.string()) }),
  'library:getSidecar':    z.object({ tapeId: z.string() }),
  'library:reveal':        z.object({ tapeId: z.string() }),
  'library:playExternal':  z.object({ tapeId: z.string() }),
  'library:probeMetadata': z.object({ tapeId: z.string() }),
  'library:applyMetadata': z.object({ tapeId: z.string(), metadata: RefreshedMetadataSchema }),

  // ── Tape ordering ──────────────────────────────────────────────────────────
  'tapes:reorder':         z.object({ orderedIds: z.array(z.string()) }),

  // ── Boxes ──────────────────────────────────────────────────────────────────
  'boxes:list':            z.undefined(),
  'boxes:create':          z.object({ name: z.string() }),
  'boxes:rename':          z.object({ boxId: z.string(), name: z.string() }),
  'boxes:delete':          z.object({ boxId: z.string() }),
  'boxes:reorder':         z.object({ orderedIds: z.array(z.string()) }),
  'boxes:place':           z.object({ tapeIds: z.array(z.string()), boxId: z.string().nullable() }),

  // ── Export ──────────────────────────────────────────────────────────────
  'export:files':          z.object({
    tapeId: z.string(),
    destinationDir: z.string(),
    name: z.string(),
    deleteFromApp: z.boolean(),
  }),

  // ── AI ──────────────────────────────────────────────────────────────────
  'ai:generateSlug':       z.object({
    tapeId: z.string(),
    include: z.object({ title: z.boolean(), uploader: z.boolean(), description: z.boolean() }),
  }),

  // ── Settings ──────────────────────────────────────────────────────────────
  'settings:get':          z.undefined(),
  'settings:defaultLibraryDir': z.undefined(),
  'settings:update':       SettingsSchema.partial(),
  'settings:setApiKey':    z.object({ apiKey: z.string() }),
  'settings:clearApiKey':  z.undefined(),
  'settings:hasApiKey':    z.undefined(),

  // ── Layout ──────────────────────────────────────────────────────────────
  'layout:get':            z.undefined(),
  'layout:update':         LayoutSchema.partial(),

  // ── Binaries ──────────────────────────────────────────────────────────────
  'binaries:status':       z.undefined(),
  'binaries:update':       z.object({ name: BinaryNameSchema }),
  'binaries:checkUpdates': z.undefined(),

  // ── Scan ──────────────────────────────────────────────────────────────────
  'scan:start':            z.object({ url: z.string() }),
  'scan:cancel':           z.object({ sessionId: z.string() }),

  // ── Native dialogs ──────────────────────────────────────────────────────
  'dialog:pickDirectory':  z.object({ title: z.string().optional() }),
  'dialog:pickFiles':      z.object({ title: z.string().optional() }),

  // ── Media ──────────────────────────────────────────────────────────────
  'media:endpoint':        z.undefined(),

  // ── Runtime info ──────────────────────────────────────────────────────────
  'app:runtimeInfo':       z.undefined(),
  'app:revealLog':         z.undefined(),
  'app:setVideoPlaying':   z.object({ playing: z.boolean() }),
} satisfies { [K in keyof IpcCalls]: z.ZodType<IpcCalls[K]['req']> }
