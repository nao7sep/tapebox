import { NewerFormatError } from './file-header'

/**
 * A store that exists but could not be opened or read: permissions, a disk
 * error. It is not missing and not corrupt, so it is left exactly as it is and
 * nothing replaces it (store-recovery-conventions); startup names it and stops.
 */
export class StoreAccessError extends Error {
  readonly path: string

  constructor(path: string, cause: unknown) {
    super(`${path} could not be read`, { cause })
    this.name = 'StoreAccessError'
    this.path = path
  }
}

/**
 * The collection folder saved in config.json could not be used. Collection work needs
 * it, and the built-in folder would be the wrong place, so startup stops and the
 * file is left as it is.
 */
export class CollectionFolderSettingError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`The collection folder saved in ${path} could not be read`)
    this.name = 'CollectionFolderSettingError'
    this.path = path
  }
}

/** Why a file was refused (store-recovery-conventions, What a refused file
 *  does): a newer TapeBox wrote it, or it could not be read. Either way it is
 *  left exactly as it is. */
export type RefusedFile = { path: string; reason: 'newer' | 'unreadable' }

/**
 * A file this build will not use or write: newer, or unreadable where its
 * content is worth keeping. It is left as it is.
 */
export class RefusedFileError extends Error {
  readonly path: string
  readonly reason: RefusedFile['reason']

  constructor(path: string, reason: RefusedFile['reason'], cause?: unknown) {
    super(reason === 'newer' ? `${path} is from a newer TapeBox` : `${path} could not be read`, { cause })
    this.name = 'RefusedFileError'
    this.path = path
    this.reason = reason
  }
}

/** Startup found files it will not use; it stops, naming every one. */
export class LaunchRefusedError extends Error {
  readonly files: readonly RefusedFile[]

  constructor(files: readonly RefusedFile[]) {
    super(`Startup stopped for ${files.map((file) => `${file.path} (${file.reason})`).join(', ')}`)
    this.name = 'LaunchRefusedError'
    this.files = files
  }
}

/** The refused file an error stands for, or null for any other failure. */
export function refusalOf(error: unknown): RefusedFile | null {
  if (error instanceof RefusedFileError) return { path: error.path, reason: error.reason }
  if (error instanceof NewerFormatError) return { path: error.path, reason: 'newer' }
  if (error instanceof StoreAccessError) return { path: error.path, reason: 'unreadable' }
  return null
}
