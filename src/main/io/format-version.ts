import type { DatabaseSync } from 'node:sqlite'

/**
 * Every store's format version, and the one way each kind of store reads and
 * writes its marker (store-recovery-conventions). Each format has its own
 * number. This module imports nothing at run time, so the records reader thread
 * (records-worker.ts) can run it as it is.
 */
export const FORMAT_VERSIONS = {
  /** catalog.json */
  catalog: 1,
  /** config.json */
  config: 1,
  /** layout.json */
  layout: 1,
  /** dependencies.json */
  dependencies: 1,
  /** api-keys.json */
  apiKeys: 1,
  /** A tape's sidecar in the library, and the copy an export writes. */
  sidecar: 1,
  /** `bin/<name>.json`, the installed version beside a managed binary. */
  binaryVersion: 1,
  /** backups.sqlite3 */
  backups: 1,
  /** records.sqlite3 */
  records: 1,
} as const

/** The marker's key in a JSON store. */
export const FORMAT_VERSION_KEY = 'formatVersion'

/** A store's marker when it has none. */
const UNMARKED_VERSION = 1

/**
 * A store written in a newer format than this build reads. It is intact: the
 * caller reports it by name and leaves it exactly as it is.
 */
export class NewerFormatError extends Error {
  // Declared fields, not parameter properties: Node's type stripping runs this
  // file as it is in the records reader thread.
  readonly path: string
  readonly version: number

  constructor(path: string, version: number, supported: number) {
    super(`${path} is format ${version}; this build reads format ${supported} and older`)
    this.name = 'NewerFormatError'
    this.path = path
    this.version = version
  }
}

export type StoreJson =
  | { status: 'read'; value: Record<string, unknown> }
  | { status: 'newer'; version: number }
  | { status: 'unreadable'; error: Error }

/**
 * Parse a JSON store's text and read its marker against `current`. A root that is
 * not an object is unreadable. The returned value still holds the marker; each
 * store's own shape ignores it.
 */
export function parseStoreJson(text: string, current: number): StoreJson {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { status: 'unreadable', error: error as Error }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'unreadable', error: new Error('the root is not a JSON object') }
  }
  return checkFormatVersion(raw as Record<string, unknown>, current)
}

/**
 * Read a parsed JSON store's marker against `current`. A missing marker reads as
 * 1; one that is not a positive integer makes the store unreadable.
 */
export function checkFormatVersion(value: Record<string, unknown>, current: number): StoreJson {
  const marker = Object.hasOwn(value, FORMAT_VERSION_KEY) ? value[FORMAT_VERSION_KEY] : UNMARKED_VERSION
  if (typeof marker !== 'number' || !Number.isSafeInteger(marker) || marker < 1) {
    return { status: 'unreadable', error: new Error(`${FORMAT_VERSION_KEY} is not a positive integer`) }
  }
  return marker > current ? { status: 'newer', version: marker } : { status: 'read', value }
}

/** `data` with `formatVersion` as its first key, replacing any marker it held. */
export function withFormatVersion(data: object, version: number): Record<string, unknown> {
  const { [FORMAT_VERSION_KEY]: _replaced, ...rest } = data as Record<string, unknown>
  return { [FORMAT_VERSION_KEY]: version, ...rest }
}

/**
 * Read an open SQLite store's format version, `PRAGMA user_version`, where the
 * 0 of a database that never set it reads as 1.
 */
export function databaseFormatVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version === 0 ? UNMARKED_VERSION : row.user_version
}

/** Record `version` in a SQLite store this build has just made current. */
export function stampDatabaseFormatVersion(db: DatabaseSync, version: number): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (row.user_version !== version) db.exec(`PRAGMA user_version = ${version}`)
}
