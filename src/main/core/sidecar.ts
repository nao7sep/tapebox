import { readFile, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { writeJsonAtomic } from '@main/io/atomic-json'
import { FORMAT_VERSIONS, NewerFormatError, parseStoreJson } from '@main/io/format-version'
import { UserFacingError } from '@main/user-facing-error'
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
  tapeboxAdditions: SidecarTapeBox
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

  data.tapebox = opts.tapeboxAdditions
  // not recorded: a tape's sidecar (yt-dlp info.json + the tapebox namespace) lives
  // in the library directory beside the downloaded media and thumbnail — a binary-
  // bearing directory. Everything colocated with binaries rides along into exclusion
  // (data-backup conventions): the sidecar is meaningless without its media, and is
  // regenerable from the source. So it takes the raw writeJsonAtomic, not the choke
  // point. The tape's durable text (its catalog row) is what records, via catalog.json.
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
  try {
    await writeJsonAtomic(path, sidecar, SIDECAR_JSON)
  } catch (error) {
    if (error instanceof NewerFormatError) {
      throw new UserFacingError('conflict', message('errors.fileNewer', { name: basename(path) }), { cause: error })
    }
    throw error
  }
}

/**
 * Read a sidecar as its raw object. One in a newer format is reported to the
 * user by name and left as it is (store-recovery-conventions); a missing or
 * unparseable file throws.
 */
export async function readSidecarFile(sidecarPath: string): Promise<Record<string, unknown>> {
  const found = parseStoreJson(await readFile(sidecarPath, 'utf8'), FORMAT_VERSIONS.sidecar, true)
  if (found.status === 'newer') {
    throw new UserFacingError('conflict', message('errors.fileNewer', { name: basename(sidecarPath) }))
  }
  if (found.status === 'unreadable') throw found.error
  return found.value
}

/**
 * Read a sidecar back as its raw object (the full yt-dlp info.json plus the
 * tapebox namespace). Best-effort: a missing, unparseable or newer-format file
 * returns null, so callers that only want an optional field (e.g. description
 * for slug generation) can treat it as simply absent.
 */
export async function readSidecar(sidecarPath: string): Promise<Record<string, unknown> | null> {
  try {
    return await readSidecarFile(sidecarPath)
  } catch {
    return null
  }
}
