import { dialog } from 'electron'

/**
 * Native error surfaces shown during startup, before the renderer (and its named
 * React modal host) exists. These are the main-process fatal-halt boxes the
 * modal-dialog conventions allow for a launch that cannot proceed — kept here,
 * named and greppable in a *-dialog file, rather than inline in the bootstrap.
 */

export function notifyCorruptConfig(quarantinePath: string): void {
  dialog.showErrorBox(
    'Settings could not be read',
    'Your TapeBox settings file was unreadable and has been set aside so nothing is lost:\n\n' +
      `${quarantinePath}\n\n` +
      'TapeBox has started with default settings. Your library and media files are untouched.',
  )
}

export function notifyCorruptSession(quarantinePath: string): void {
  dialog.showErrorBox(
    'Library could not be opened',
    'Your TapeBox library file was unreadable and has been set aside so nothing is lost:\n\n' +
      `${quarantinePath}\n\n` +
      'TapeBox has started with an empty library. Your downloaded media files are untouched.',
  )
}

export function notifyStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox('TapeBox could not start', `${message}\n\nTapeBox will now quit.`)
}
