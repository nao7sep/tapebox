import { readFile, unlink } from 'node:fs/promises'
import { writeJsonAtomic } from '@main/io/atomic-json'
import type { SidecarTapeBox } from '@shared/domain'

/**
 * Build the final sidecar JSON from yt-dlp's info.json output.
 *
 * Layout:
 *   { ...ytDlpInfoJson_with_paths_stripped, tapebox: SidecarTapeBox }
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
  await writeJsonAtomic(opts.sidecarPath, data)
  await unlink(opts.infoJsonPath).catch(() => {})
}

/**
 * Read a sidecar back as its raw object (the full yt-dlp info.json plus the
 * tapebox namespace). Best-effort: a missing or unparseable file returns null,
 * so callers that only want an optional field (e.g. description for slug
 * generation) can treat it as simply absent.
 */
export async function readSidecar(sidecarPath: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(sidecarPath, 'utf8')
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}
