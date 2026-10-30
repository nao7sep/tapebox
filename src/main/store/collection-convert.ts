import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { areaDir, LEGACY_CATALOG, shelfFile, tapeDir, tapeFile } from '@main/paths'
import { quarantineFile, writeManagedJsonBytes } from '@main/io/atomic-json'
import { StoreAccessError } from '@main/io/store-access'
import { NewerFormatError, parseStoreJson } from '@main/io/format-version'
import { BoxSchema, TAPE_FILE, TapeSchema, type Session, type Tape } from '@shared/domain'
import { encodeShelf, encodeTapeFile } from './collection-files'

/**
 * The layout before Inbox and Shelf: `<collection>/<id>/` tape folders and a
 * catalog.json (format 1) holding every tape with its archive marker, box and
 * order, and the boxes. It is converted once, when the collection is opened.
 */
const LEGACY_CATALOG_FORMAT = 1

const LegacyCatalogSchema = z.object({
  tapes: z.array(TapeSchema.omit({ shelved: true, addedIndex: true }).extend({ archivedAtUtc: z.string().nullable() })),
  boxes: z.array(BoxSchema),
})
type LegacyTape = z.infer<typeof LegacyCatalogSchema>['tapes'][number]

export type ConversionResult =
  | { status: 'converted'; tapeCount: number }
  /** The old catalog could not be read, so it was set aside and nothing was converted. */
  | { status: 'recovered'; quarantinePath: string }

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** The collection the old catalog describes, each tape where it will sit. Tapes
 *  added at the same moment keep the order the old Inbox gave them. */
export function legacySession(tapes: readonly LegacyTape[], boxes: Session['boxes']): Session {
  const rank = new Map<string, number>()
  const byTime = new Map<string, LegacyTape[]>()
  for (const tape of tapes) byTime.set(tape.addedAtUtc, [...(byTime.get(tape.addedAtUtc) ?? []), tape])
  for (const group of byTime.values()) {
    group.sort((a, b) => Number(a.archivedAtUtc !== null) - Number(b.archivedAtUtc !== null) || a.order - b.order)
      .forEach((tape, index) => rank.set(tape.id, index))
  }
  return {
    boxes,
    tapes: tapes.map(({ archivedAtUtc, ...tape }): Tape => ({
      ...tape,
      addedIndex: rank.get(tape.id)!,
      shelved: archivedAtUtc !== null,
      boxId: archivedAtUtc === null ? null : tape.boxId,
      order: archivedAtUtc === null ? 0 : tape.order,
    })),
  }
}

/**
 * Convert the old layout at `collectionDir`: each tape's folder is moved into
 * inbox/ or shelf/ and given its tape.json, then shelf.json is written, and the
 * old catalog is deleted last. The old catalog stays the authority until then,
 * so a conversion stopped at any point runs again from it and loses nothing: a
 * folder already moved is found where it went, and its tape.json written again.
 *
 * A catalog in a newer format throws {@link NewerFormatError} and is left as it
 * is. One that cannot be read is set aside, or, with `requireExisting`, throws.
 */
export async function convertLegacyCollection(
  collectionDir: string,
  options: { requireExisting?: boolean } = {},
): Promise<ConversionResult> {
  const catalogPath = join(collectionDir, LEGACY_CATALOG)
  let text: string
  try {
    text = await readFile(catalogPath, 'utf8')
  } catch (err) {
    throw new StoreAccessError(catalogPath, err)
  }
  const found = parseStoreJson(text, LEGACY_CATALOG_FORMAT)
  if (found.status === 'newer') throw new NewerFormatError(catalogPath, found.version, LEGACY_CATALOG_FORMAT)
  const parsed = found.status === 'read' ? LegacyCatalogSchema.safeParse(found.value) : null
  if (!parsed?.success) {
    if (options.requireExisting) throw new StoreAccessError(catalogPath, new Error('Invalid library catalog'))
    return { status: 'recovered', quarantinePath: await quarantineFile(catalogPath) }
  }
  const session = legacySession(parsed.data.tapes, parsed.data.boxes)

  for (const shelved of [false, true]) await mkdir(areaDir(collectionDir, shelved), { recursive: true })
  for (const tape of session.tapes) {
    const target = tapeDir(collectionDir, tape)
    const candidates = [
      join(collectionDir, tape.id),
      tapeDir(collectionDir, { id: tape.id, shelved: !tape.shelved }),
    ]
    let moved = false
    for (const source of candidates) {
      if (!await exists(source)) continue
      await rename(source, target)
      moved = true
      break
    }
    if (!moved) await mkdir(target, { recursive: true })
    await writeManagedJsonBytes(tapeFile(collectionDir, tape, TAPE_FILE), encodeTapeFile(tape))
  }
  await writeManagedJsonBytes(shelfFile(collectionDir), encodeShelf(session))
  await unlink(catalogPath)
  return { status: 'converted', tapeCount: session.tapes.length }
}
