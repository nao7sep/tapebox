import { readdir, readFile } from 'node:fs/promises'
import { areaDir, shelfFile, tapeFile } from '@main/paths'
import { quarantineFile, serializeStoreJson } from '@main/io/atomic-json'
import { StoreAccessError } from '@main/io/store-access'
import { FORMAT_VERSIONS, NewerFormatError, parseStoreJson } from '@main/io/format-version'
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
export type DamagedTape = { id: string; path: string; reason: string }

export type CollectionLoadResult =
  | { status: 'loaded'; tapeCount: number }
  | { status: 'empty' }
  | { status: 'recovered'; quarantinePath: string }

export type CollectionRead = {
  result: CollectionLoadResult
  session: Session
  damaged: DamagedTape[]
  /** False when shelf.json is missing or was set aside, so the next save writes it. */
  shelfWritten: boolean
}

const TAPE_JSON = { formatVersion: FORMAT_VERSIONS.tape, schema: TapeFileSchema }
const SHELF_JSON = { formatVersion: FORMAT_VERSIONS.shelf, schema: ShelfSchema }

/** What a tape's own file holds: its durable facts. */
export function tapeFacts(tape: Tape): TapeFile {
  const { shelved: _shelved, boxId: _boxId, order: _order, ...facts } = durableTape(tape)
  return facts
}

/** The exact bytes of `tape`'s own file. */
export function encodeTapeFile(tape: Tape): Buffer {
  return Buffer.from(serializeStoreJson(tapeFacts(tape), TAPE_JSON), 'utf8')
}

/** The exact bytes of shelf.json for `session`. */
export function encodeShelf(session: Session): Buffer {
  return Buffer.from(serializeStoreJson(shelfOf(session), SHELF_JSON), 'utf8')
}

function byOrder(a: { order: number }, b: { order: number }): number {
  return a.order - b.order
}

/** The Shelf's organization, as shelf.json records it. */
export function shelfOf(session: Session): Shelf {
  const ids = (tapes: Tape[]) => tapes.sort(byOrder).map((tape) => tape.id)
  return {
    boxes: [...session.boxes].sort(byOrder).map(({ id, name }) => ({
      id,
      name,
      tapeIds: ids(session.tapes.filter((tape) => tape.shelved && tape.boxId === id)),
    })),
    loose: ids(session.tapes.filter((tape) => tape.shelved && tape.boxId === null)),
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
  | { kind: 'recovered'; quarantinePath: string }

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
  const found = parseStoreJson(text, FORMAT_VERSIONS.shelf)
  if (found.status === 'newer') throw new NewerFormatError(path, found.version, FORMAT_VERSIONS.shelf)
  const parsed = found.status === 'read' ? ShelfSchema.safeParse(found.value) : null
  if (parsed?.success) return { kind: 'shelf', shelf: parsed.data }
  if (requireExisting) throw new StoreAccessError(path, new Error('Invalid shelf file'))
  const parseErr = found.status === 'unreadable' ? found.error : parsed?.error
  try {
    return { kind: 'recovered', quarantinePath: await quarantineFile(path) }
  } catch (quarantineErr) {
    const detail = (quarantineErr as Error)?.message ?? String(quarantineErr)
    throw new Error(`shelf file at ${path} is corrupt and could not be set aside: ${detail}`, { cause: parseErr })
  }
}

/** One tape folder's tape.json, or why it could not be read. */
export async function readTapeFile(path: string, id: string): Promise<TapeFile | { reason: string } | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { reason: (err as Error).message ?? String(err) }
  }
  const found = parseStoreJson(text, FORMAT_VERSIONS.tape)
  if (found.status !== 'read') return { reason: found.status === 'newer' ? `format ${found.version} is newer` : found.error.message }
  const parsed = TapeFileSchema.safeParse(found.value)
  if (!parsed.success) return { reason: parsed.error.message }
  if (parsed.data.id !== id) return { reason: `does not hold the tape ${id}` }
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
      if ('reason' in file) damaged.push({ id, path, reason: file.reason })
      else if (identities.has(identity)) damaged.push({ id, path, reason: `the tape ${id} is in the collection twice` })
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
 * A corrupt or schema-invalid shelf.json is **never discarded**: it is renamed
 * to a timestamped `shelf-*.invalid` sibling, and every tape still shows, the
 * shelved ones as loose tapes. A shelf.json in a newer format throws
 * {@link NewerFormatError} and is left as it is. With
 * `requireExisting`, a collection without a valid shelf.json throws and nothing
 * is written.
 */
export async function readCollection(
  collectionDir: string,
  options: { requireExisting?: boolean } = {},
): Promise<CollectionRead> {
  const shelf = await readShelf(collectionDir, options.requireExisting ?? false)
  const { inbox, shelved, damaged } = await readTapeFiles(collectionDir)
  const session = assembleSession(shelf.kind === 'shelf' ? shelf.shelf : { boxes: [], loose: [] }, inbox, shelved)
  const tapeCount = session.tapes.length
  const result: CollectionLoadResult =
    shelf.kind === 'recovered' ? { status: 'recovered', quarantinePath: shelf.quarantinePath }
      : shelf.kind === 'missing' && tapeCount === 0 ? { status: 'empty' }
        : { status: 'loaded', tapeCount }
  return { result, session, damaged, shelfWritten: shelf.kind === 'shelf' }
}
