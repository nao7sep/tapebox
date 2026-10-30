import { readFile, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { writeJsonAtomic } from '@main/io/atomic-json'
import { FORMAT_VERSIONS, parseStoreJson } from '@main/io/format-version'
import { UserFacingError } from '@main/user-facing-error'
import type { SidecarMedia, SidecarTapeBox, Tape } from '@shared/domain'
import { message } from '@shared/i18n/translate'

/**
 * Build the final sidecar JSON from yt-dlp's info.json output.
 *
 * Layout in the library:
 *   { formatVersion, ...ytDlpInfoJson_with_paths_stripped, tapebox: { media } }
 *
 * The catalog holds everything else about the tape; an export adds it back
 * ({@link exportNamespace}).
 *
 * The yt-dlp portion is intentionally NOT zod-validated (large, evolving
 * surface); only the 'tapebox' namespace is validated by callers.
 */

const PATH_FIELDS_ROOT = [
  'filename',
  '_filename',
  'filepath',
  '_filepath',
  '__finaldir',
  '__files_to_move',
  'requested_downloads',
] as const

const PATH_FIELDS_NESTED_ARRAYS = ['formats', 'requested_formats'] as const
const NESTED_PATH_KEYS = ['filepath'] as const

export async function finalize(opts: {
  infoJsonPath: string
  sidecarPath: string
  media: SidecarMedia | null
}): Promise<void> {
  const text = await readFile(opts.infoJsonPath, 'utf8')
  const data = JSON.parse(text) as Record<string, unknown>

  for (const key of PATH_FIELDS_ROOT) delete data[key]

  for (const arrKey of PATH_FIELDS_NESTED_ARRAYS) {
    const arr = data[arrKey]
    if (Array.isArray(arr)) {
      for (const tape of arr) {
        if (tape && typeof tape === 'object') {
          for (const k of NESTED_PATH_KEYS) delete (tape as Record<string, unknown>)[k]
        }
      }
    }
  }

  data.tapebox = { media: opts.media }
  // not recorded: a tape's sidecar (yt-dlp info.json + the tapebox namespace) is
  // library content, transient and app-owned until exported (developer
  // classification), so it takes the raw writeJsonAtomic, not the choke point. The
  // tape's catalog row is what records, via catalog.json.
  await writeSidecar(opts.sidecarPath, data)
  await unlink(opts.infoJsonPath).catch(() => {})
}

/** How every sidecar is serialized: the library's own and an export's copy. */
export const SIDECAR_JSON = { formatVersion: FORMAT_VERSIONS.sidecar }

/**
 * Write a sidecar in the library, stamped with its format version. Not recorded:
 * see {@link finalize}.
 */
export async function writeSidecar(path: string, sidecar: Record<string, unknown>): Promise<void> {
  await writeJsonAtomic(path, sidecar, SIDECAR_JSON)
}

/**
 * Read a sidecar as its raw object. One in a newer format is reported to the
 * user by name and left as it is (store-recovery-conventions); a missing or
 * unparseable file throws.
 */
export async function readSidecarFile(sidecarPath: string): Promise<Record<string, unknown>> {
  const found = parseStoreJson(await readFile(sidecarPath, 'utf8'), FORMAT_VERSIONS.sidecar)
  if (found.status === 'newer') {
    throw new UserFacingError('conflict', message('errors.fileNewer', { name: basename(sidecarPath) }))
  }
  if (found.status === 'unreadable') throw found.error
  return found.value
}

/** The catalog fields an exported sidecar carries in its tapebox section. */
const CATALOG_FIELDS = ['sourceUrl', 'name', 'addedAtUtc', 'downloadedAtUtc', 'renamedAtUtc', 'mediaFilename', 'thumbnailFilename'] as const

/** A sidecar as the library keeps it: an imported bundle's catalog fields,
 *  which the catalog now holds, leave its tapebox section; the media facts and
 *  anything else in it stay. */
export function collectionSidecar(sidecar: Record<string, unknown>): Record<string, unknown> {
  const section = sidecar['tapebox']
  const kept = section && typeof section === 'object' && !Array.isArray(section)
    ? Object.fromEntries(Object.entries(section).filter(([key]) => !(CATALOG_FIELDS as readonly string[]).includes(key)))
    : {}
  return { ...sidecar, tapebox: { media: null, ...kept } }
}

/** The tapebox section an exported sidecar carries: the catalog's record of the
 *  tape beside what the library sidecar's own section holds, so the bundle can
 *  be imported from its sidecar alone. */
export function exportNamespace(sidecar: Record<string, unknown>, tape: Tape): SidecarTapeBox & Record<string, unknown> {
  const kept = collectionSidecar(sidecar)['tapebox'] as Record<string, unknown>
  return {
    ...kept,
    media: (kept['media'] ?? null) as SidecarMedia | null,
    sourceUrl: tape.sourceUrl,
    name: tape.name,
    addedAtUtc: tape.addedAtUtc,
    downloadedAtUtc: tape.downloadedAtUtc,
    renamedAtUtc: tape.renamedAtUtc,
    mediaFilename: tape.filename,
    thumbnailFilename: tape.thumbnailFilename,
  }
}
