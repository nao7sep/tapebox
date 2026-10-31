import { readFile, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { writeJsonAtomic } from '@main/io/atomic-json'
import { checkFileHeader, FORMATS, parseStoreJson, type StoreJson } from '@main/io/file-header'
import { UserFacingError } from '@main/user-facing-error'
import type { SidecarMedia, SidecarTapeBox, Tape } from '@shared/domain'
import { message } from '@shared/i18n/translate'

/**
 * Build the final sidecar JSON from yt-dlp's info.json output.
 *
 * Layout in the collection:
 *   { format, writer, ytDlp: ytDlpInfoJson_with_paths_stripped, tapebox: { media } }
 *
 * yt-dlp's payload sits under a key of its own, so its own fields (its `format`
 * among them) never meet the header (file-identity-conventions).
 *
 * The tape's tape.json holds everything else about it; an export adds it back
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

  // not recorded: a tape's sidecar (yt-dlp info.json + the tapebox namespace) is
  // collection content, transient and app-owned until exported (developer
  // classification), so it takes the raw writeJsonAtomic, not the choke point. The
  // tape's tape.json is what records.
  await writeSidecar(opts.sidecarPath, { ytDlp: data, tapebox: { media: opts.media } })
  await unlink(opts.infoJsonPath).catch(() => {})
}

/** How every sidecar is serialized: the collection's own and an export's copy. */
export const SIDECAR_JSON = { format: FORMATS.sidecar }

/** A sidecar's content once its header is checked: yt-dlp's info.json under
 *  `ytDlp`, beside TapeBox's own `tapebox` section. */
export type Sidecar = Record<string, unknown> & { ytDlp: Record<string, unknown>; tapebox: Record<string, unknown> }

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** A sidecar's header, then its two sections: one without either section is
 *  unreadable. */
export function checkSidecar(found: StoreJson): { status: 'read'; value: Sidecar } | Exclude<StoreJson, { status: 'read' }> {
  if (found.status !== 'read') return found
  if (!isObject(found.value['ytDlp']) || !isObject(found.value['tapebox'])) {
    return { status: 'unreadable', error: new Error('not a TapeBox sidecar: it needs a ytDlp and a tapebox section') }
  }
  return { status: 'read', value: found.value as Sidecar }
}

/** A parsed sidecar's header and sections. */
export function sidecarIn(value: Record<string, unknown>): ReturnType<typeof checkSidecar> {
  return checkSidecar(checkFileHeader(value, FORMATS.sidecar))
}

/**
 * Write a sidecar in the collection, led by its header. Not recorded:
 * see {@link finalize}.
 */
export async function writeSidecar(path: string, sidecar: Sidecar): Promise<void> {
  await writeJsonAtomic(path, sidecar, SIDECAR_JSON)
}

/**
 * Read a sidecar's content. One in a newer format is reported to the
 * user by name and left as it is (store-recovery-conventions); a missing or
 * unparseable file throws.
 */
export async function readSidecarFile(sidecarPath: string): Promise<Sidecar> {
  const found = checkSidecar(parseStoreJson(await readFile(sidecarPath, 'utf8'), FORMATS.sidecar))
  if (found.status === 'newer') {
    throw new UserFacingError('conflict', message('errors.fileNewer', { name: basename(sidecarPath) }))
  }
  if (found.status === 'unreadable') throw found.error
  return found.value
}

/** The tape.json fields an exported sidecar carries in its tapebox section. */
const TAPE_FIELDS = ['sourceUrl', 'name', 'addedAtUtc', 'downloadedAtUtc', 'renamedAtUtc', 'mediaFilename', 'thumbnailFilename'] as const

/** A sidecar as the collection keeps it: an imported bundle's tape.json fields,
 *  which its tape.json now holds, leave its tapebox section; the media facts and
 *  anything else in it stay. */
export function collectionSidecar(sidecar: Sidecar): Sidecar {
  const section = sidecar['tapebox']
  const kept = section && typeof section === 'object' && !Array.isArray(section)
    ? Object.fromEntries(Object.entries(section).filter(([key]) => !(TAPE_FIELDS as readonly string[]).includes(key)))
    : {}
  return { ...sidecar, tapebox: { media: null, ...kept } }
}

/** The tapebox section an exported sidecar carries: the tape.json record of the
 *  tape beside what the collection sidecar's own section holds, so the bundle can
 *  be imported from its sidecar alone. */
export function exportNamespace(sidecar: Sidecar, tape: Tape): SidecarTapeBox & Record<string, unknown> {
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
