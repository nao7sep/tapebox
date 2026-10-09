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
 * The library folder saved in config.json could not be used. Library work needs
 * it, and the built-in folder would be the wrong place, so startup stops and the
 * file is left as it is.
 */
export class LibraryFolderSettingError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`The library folder saved in ${path} could not be read`)
    this.name = 'LibraryFolderSettingError'
    this.path = path
  }
}
