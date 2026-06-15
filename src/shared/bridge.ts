import type { LogMessage } from './log'

/**
 * The contextBridge surface preload exposes on `window.tapebox`.
 *
 * Single source of truth for that surface: preload implements it with
 * `satisfies TapeBoxApi`, and every renderer consumer (ipc/client.ts,
 * ipc/log.ts) casts `window.tapebox` to this same interface — so the
 * hand-written bridge and its callers cannot silently drift apart.
 *
 * This is the generic transport only — string channels, `unknown` payloads.
 * The renderer layers the typed @shared/ipc-contract over `invoke`/`on` in
 * ipc/client.ts. `File` resolves from the DOM lib in the renderer (web) program
 * and from @types/node's web globals in the preload (node) program, so this
 * shared interface type-checks in both.
 */
export interface TapeBoxApi {
  invoke(channel: string, req: unknown): Promise<unknown>
  on(channel: string, listener: (payload: unknown) => void): () => void
  pathForFile(file: File): string
  log(message: LogMessage): void
  isDebugEnabled: boolean
}
