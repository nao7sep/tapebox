import { unlink } from 'node:fs/promises'
import { writeFileAtomicVia } from '@main/io/atomic-file'
import { sidecarCodec } from '@main/io/sidecar-codec'
import type { SidecarProjection, SidecarRewrite, SidecarReadMode } from '@main/io/sidecar-stream'
import { basename } from 'node:path'
import { FORMAT_VERSIONS, checkFormatVersion } from '@main/io/format-version'
import { UserFacingError } from '@main/user-facing-error'
import { classifyImport } from './import-classify'
import type { Tape } from '@shared/domain'
import type { SidecarTapeBox } from '@shared/domain'
import { message } from '@shared/i18n/translate'

/**
 * Build the final sidecar JSON from yt-dlp's info.json output.
 *
 * Layout:
 *   { formatVersion, ...ytDlpInfoJson_with_paths_stripped, tapebox: SidecarTapeBox }
 *
 * The yt-dlp portion is intentionally NOT zod-validated (large, evolving
 * surface); only the 'tapebox' namespace is validated by callers.
 */

export async function finalize(opts: {
  infoJsonPath: string
  sidecarPath: string
  tapeboxAdditions: SidecarTapeBox
}): Promise<void> {
  await writeFileAtomicVia(opts.sidecarPath, temp => writeSidecarStage(opts.infoJsonPath, temp, {
    root: { tapebox: opts.tapeboxAdditions }, stripPaths: true,
  }))
  await unlink(opts.infoJsonPath).catch(() => {})
}

/** Consumed fields only; opaque source metadata stays in the source file. */
export async function readSidecarProjection(path: string, signal?: AbortSignal, mode: SidecarReadMode = 'preview'): Promise<SidecarProjection> {
  return (await sidecarCodec({ op: 'read', path, mode }, signal))!
}
export async function readSidecarDocument(path: string, signal?: AbortSignal, mode: SidecarReadMode = 'preview'): Promise<{ value: Record<string, unknown>; stamp: string; chapterCount: number | null }> {
  const document = await readSidecarProjection(path, signal, mode)
  const value = document.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('the root is not a JSON object')
  const found = checkFormatVersion(value as Record<string, unknown>, FORMAT_VERSIONS.sidecar)
  if (found.status === 'newer') throw new UserFacingError('conflict', message('errors.fileNewer', { name: basename(path) }))
  if (found.status === 'unreadable') throw found.error
  return { value: found.value, stamp: document.stamp, chapterCount: document.chapterCount }
}
export async function readSidecarFile(path: string, signal?: AbortSignal, mode: SidecarReadMode = 'preview'): Promise<Record<string, unknown>> {
  return (await readSidecarDocument(path, signal, mode)).value
}
export async function writeSidecarStage(path: string, output: string, patch: SidecarRewrite, expectedStamp?: string, signal?: AbortSignal): Promise<void> {
  await sidecarCodec({ op: 'rewrite', path, output, patch, version: FORMAT_VERSIONS.sidecar, expectedStamp }, signal)
}
export async function rewriteSidecar(path: string, patch: SidecarRewrite, expectedStamp: string, signal?: AbortSignal): Promise<void> {
  await writeFileAtomicVia(path, temp => writeSidecarStage(path, temp, patch, expectedStamp, signal), undefined, signal)
}
/** Defaults fill absent fields; existing subobjects are never copied into a
 * replacement patch, so opaque children survive a managed-field change. */
export function sidecarNamespacePatch(sidecar: Record<string, unknown>, tape: Tape, changes: Record<string, unknown>): Record<string, unknown> {
  const admission = classifyImport(sidecar)
  if (admission.status === 'reject') throw new UserFacingError('invalid', admission.reason)
  const existing = sidecar['tapebox'] as Record<string, unknown>
  const defaults = {
    sourceUrl: tape.sourceUrl, name: tape.name, addedAtUtc: tape.addedAtUtc,
    downloadedAtUtc: tape.downloadedAtUtc, renamedAtUtc: tape.renamedAtUtc,
    media: null, mediaFilename: tape.filename, thumbnailFilename: tape.thumbnailFilename,
  }
  return { ...Object.fromEntries(Object.entries(defaults).filter(([key]) => !Object.hasOwn(existing, key))), ...changes }
}
