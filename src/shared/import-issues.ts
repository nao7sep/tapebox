import type { MessageKey } from './i18n/catalogues'

/**
 * The reason main gives a sidecar whose tape is already in the library. The
 * import result names it apart from real problems, so a selection of duplicates
 * reads as "already there" rather than as a failure.
 */
export const ALREADY_IN_LIBRARY: MessageKey = 'import.alreadyInLibrary'
