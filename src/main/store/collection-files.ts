import { readdir, readFile } from 'node:fs/promises'
import { areaDir, shelfFile, tapeFile } from '@main/paths'
import { serializeStoreJson } from '@main/io/atomic-json'
import { RefusedFileError, StoreAccessError } from '@main/io/store-access'
import { FORMATS, parseStoreJson } from '@main/io/file-header'
import { durableTape } from '@shared/durable-tape'
import { portableFilenameIdentity } from '@shared/filename'
import { compareInbox } from '@shared/order'
import {
  EntityIdSchema,
  ShelfSchema,
  TAPE_FILE,
  TapeFileSchema,
  type Box,
  type Session,
  type Shelf,
  type Tape,
  type TapeFile,
} from '@shared/domain'

/**
 * The collection on disk (data-lifecycle-conventions, Items list and sort
 * themselves): `inbox/<id>/` and `shelf/<id>/` tape folders, each with a
 * tape.json holding the tape's facts, and shelf.json holding only what the user
 * decided about the Shelf — its boxes and the order of their tapes and of the
 * loose ones. Where a tape sits is which folder it is in; the Inbox has no list
 * and is sorted by when its tapes were added.
 *
 * Path-taking and free of module state, like the rest of the I/O layer; the
 * session store owns when these run.
 */

/** A tape folder whose tape.json could not be read. Its files are left as they are. */
/** A tape whose tape.json was refused; `newer` when a newer TapeBox wrote it. */
export type DamagedTape = { id: string; path: string; reason: string; newer: boolean }

/** Where shelf.json put a shelved tape whose tape.json was refused: the tape
 *  is not loaded, but its place is kept, so a later save does not lose it. */
export type HeldPlace = { id: string; boxId: string | null; index: number }

export type CollectionLoadResult =
  | { status: 'loaded'; tapeCount: number }
  | { status: 'empty' }

export type CollectionRead = {
  result: CollectionLoadResult
  session: Session
  damaged: DamagedTape[]
  held: HeldPlace[]
  /** False when shelf.json is missing, so the next save writes it. */
  shelfWritten: boolean
}

const TAPE_JSON = { format: FORMATS.tape, schema: TapeFileSchema }
const SHELF_JSON = { format: FORMATS.shelf, schema: ShelfSchema }

/** What a tape's own file holds: its durable facts. */
export function tapeFacts(tape: Tape): TapeFile {
  const { shelved: _shelved, boxId: _boxId, order: _order, ...facts } = durableTape(tape)
  return facts
}

/** The exact bytes of `tape`'s own file. */
export function encodeTapeFile(tape: Tape): Buffer {
  return Buffer.from(serializeStoreJson(tapeFacts(tape), TAPE_JSON), 'utf8')
}

/** The exact bytes of shelf.json for `session`, keeping the places `held`
 *  for refused tapes. */
export function encodeShelf(session: Session, held: readonly HeldPlace[] = []): Buffer {
  return Buffer.from(serializeStoreJson(shelfOf(session, held), SHELF_JSON), 'utf8')
}

function byOrder(a: { order: number }, b: { order: number }): number {
  return a.order - b.order
}

/** The Shelf's organization, as shelf.json records it. A held place goes back
 *  at its index in its list, or at the end of the loose tapes once its box is
 *  gone. */
export function shelfOf(session: Session, held: readonly HeldPlace[] = []): Shelf {
  const boxIds = new Set(session.boxes.map((box) => box.id))
  const ids = (tapes: Tape[], boxId: string | null) => {
    const list = tapes.sort(byOrder).map((tape) => tape.id)
    const places = held.filter((place) => place.boxId === boxId).sort((a, b) => a.index - b.index)
    for (const place of places) list.splice(Math.min(place.index, list.length), 0, place.id)
    if (boxId === null) list.push(...held.filter((place) => place.boxId !== null && !boxIds.has(place.boxId)).map((place) => place.id))
    return list
  }
  return {
    boxes: [...session.boxes].sort(byOrder).map(({ id, name }) => ({
      id,
      name,
      tapeIds: ids(session.tapes.filter((tape) => tape.shelved && tape.boxId === id), id),
    })),
    loose: ids(session.tapes.filter((tape) => tape.shelved && tape.boxId === null), null),
  }
}

/**
 * Place each tape. An Inbox tape needs no place. A Shelf tape sits where
 * shelf.json puts it; one that shelf.json does not place goes on top of the
 * loose tapes, newest added first. An id with no Shelf folder is dropped, and a
 * tape named twice keeps its first place.
 */
export function assembleSession(shelf: Shelf, inbox: readonly TapeFile[], shelved: readonly TapeFile[]): Session {
  const boxes: Box[] = shelf.boxes.map(({ id, name }, order) => ({ id, name, order }))
  const place = new Map<string, { boxId: string | null; index: number }>()
  for (const box of shelf.boxes) {
    box.tapeIds.forEach((id, index) => { if (!place.has(id)) place.set(id, { boxId: box.id, index }) })
  }
  shelf.loose.forEach((id, index) => { if (!place.has(id)) place.set(id, { boxId: null, index }) })

  const tapes: Tape[] = [...inbox].sort(compareInbox).map((file) => ({ ...file, shelved: false, boxId: null, order: 0 }))
  const lists = new Map<string | null, TapeFile[]>()
  for (const file of shelved) {
    const boxId = place.get(file.id)?.boxId ?? null
    lists.set(boxId, [...(lists.get(boxId) ?? []), file])
  }
  for (const [boxId, members] of lists) {
    const placed = members.filter((file) => place.get(file.id)?.boxId === boxId)
      .sort((a, b) => place.get(a.id)!.index - place.get(b.id)!.index)
    const unplaced = members.filter((file) => !place.has(file.id)).sort(compareInbox)
    ;[...unplaced, ...placed].forEach((file, order) => tapes.push({ ...file, shelved: true, boxId, order }))
  }
  return { tapes, boxes }
}

type ShelfRead =
  | { kind: 'shelf'; shelf: Shelf }
  | { kind: 'missing' }

async function readShelf(collectionDir: string, requireExisting: boolean): Promise<ShelfRead> {
  const path = shelfFile(collectionDir)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !requireExisting) return { kind: 'missing' }
    // Unexpected read failure (permissions, I/O): the caller leaves the
    // collection unloaded and startup names the file, instead of starting empty.
    throw new StoreAccessError(path, err)
  }
  const found = parseStoreJson(text, FORMATS.shelf)
  if (found.status === 'newer') throw new RefusedFileError(path, 'newer')
  const parsed = found.status === 'read' ? ShelfSchema.safeParse(found.value) : null
  if (parsed?.success) return { kind: 'shelf', shelf: parsed.data }
  // The boxes and their order are what the user built: refused and left as it
  // is, never set aside (store-recovery-conventions).
  throw new RefusedFileError(path, 'unreadable', found.status === 'unreadable' ? found.error : parsed?.error)
}

/** One tape folder's tape.json, or why it could not be read. */
export async function readTapeFile(path: string, id: string): Promise<TapeFile | { reason: string; newer: boolean } | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { reason: (err as Error).message ?? String(err), newer: false }
  }
  const found = parseStoreJson(text, FORMATS.tape)
  if (found.status === 'newer') return { reason: `format ${found.version} is newer`, newer: true }
  if (found.status !== 'read') return { reason: found.error.message, newer: false }
  const parsed = TapeFileSchema.safeParse(found.value)
  if (!parsed.success) return { reason: parsed.error.message, newer: false }
  if (parsed.data.id !== id) return { reason: `does not hold the tape ${id}`, newer: false }
  return parsed.data
}

/** Every tape folder's tape.json in the Inbox and the Shelf. A folder without
 *  one is not a tape; one that cannot be read is damaged and left as it is. */
async function readTapeFiles(collectionDir: string): Promise<{ inbox: TapeFile[]; shelved: TapeFile[]; damaged: DamagedTape[] }> {
  const damaged: DamagedTape[] = []
  const identities = new Set<string>()
  const read = async (shelvedArea: boolean): Promise<TapeFile[]> => {
    const dir = areaDir(collectionDir, shelvedArea)
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new StoreAccessError(dir, err)
    }
    const files: TapeFile[] = []
    const folders = entries
      .filter((entry) => entry.isDirectory() && EntityIdSchema.safeParse(entry.name).success)
      .map((entry) => entry.name)
      .sort()
    for (const id of folders) {
      const path = tapeFile(collectionDir, { id, shelved: shelvedArea }, TAPE_FILE)
      const file = await readTapeFile(path, id)
      if (file === null) continue
      // Ids differing only in case would share one folder on a case-insensitive
      // drive, and one tape is in one place.
      const identity = portableFilenameIdentity(id)
      if ('reason' in file) damaged.push({ id, path, reason: file.reason, newer: file.newer })
      else if (identities.has(identity)) damaged.push({ id, path, reason: `the tape ${id} is in the collection twice`, newer: false })
      else {
        identities.add(identity)
        files.push(file)
      }
    }
    return files
  }
  const inbox = await read(false)
  const shelved = await read(true)
  return { inbox, shelved, damaged }
}

/**
 * Read the collection at `collectionDir`: its tape folders and shelf.json.
 *
 * A shelf.json that is newer or cannot be read throws {@link RefusedFileError}
 * and is left as it is. A tape whose tape.json is refused is named as damaged
 * and not loaded; when it is on the Shelf, its place is held. With
 * `requireExisting`, a collection without shelf.json throws and nothing is
 * written.
 */
export async function readCollection(
  collectionDir: string,
  options: { requireExisting?: boolean } = {},
): Promise<CollectionRead> {
  const shelf = await readShelf(collectionDir, options.requireExisting ?? false)
  const { inbox, shelved, damaged } = await readTapeFiles(collectionDir)
  const recorded = shelf.kind === 'shelf' ? shelf.shelf : { boxes: [], loose: [] }
  const session = assembleSession(recorded, inbox, shelved)
  const tapeCount = session.tapes.length
  const result: CollectionLoadResult = shelf.kind === 'missing' && tapeCount === 0 ? { status: 'empty' } : { status: 'loaded', tapeCount }
  return { result, session, damaged, held: heldPlaces(recorded, damaged, session), shelfWritten: shelf.kind === 'shelf' }
}

/** The recorded places of shelved tapes that were refused. */
function heldPlaces(shelf: Shelf, damaged: readonly DamagedTape[], session: Session): HeldPlace[] {
  const loaded = new Set(session.tapes.map((tape) => tape.id))
  const refused = new Set(damaged.filter((tape) => !loaded.has(tape.id)).map((tape) => tape.id))
  const held: HeldPlace[] = []
  const seen = new Set<string>()
  const keep = (id: string, boxId: string | null, index: number) => {
    if (refused.has(id) && !seen.has(id)) { seen.add(id); held.push({ id, boxId, index }) }
  }
  for (const box of shelf.boxes) box.tapeIds.forEach((id, index) => keep(id, box.id, index))
  shelf.loose.forEach((id, index) => keep(id, null, index))
  return held
}
