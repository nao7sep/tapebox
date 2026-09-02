import { showPlainMessageDialog } from './plain-message-dialog.js'

/**
 * App-authored recovery surfaces shown during startup. They deliberately avoid
 * framework message boxes, whose platform artwork can reintroduce a redundant
 * severity or application icon.
 */

export async function notifyCorruptConfig(quarantinePath: string): Promise<void> {
  await showPlainMessageDialog({
    title: 'Settings could not be read',
    message: 'Your TapeBox settings file was unreadable and has been set aside so nothing is lost.',
    detail: `Saved copy: ${quarantinePath}\n\nTapeBox has started with default settings. Your library and media files are untouched.`,
  })
}

export async function notifyCorruptSession(quarantinePath: string): Promise<void> {
  await showPlainMessageDialog({
    title: 'Library could not be opened',
    message: 'Your TapeBox library file was unreadable and has been set aside so nothing is lost.',
    detail: `Saved copy: ${quarantinePath}\n\nTapeBox has started with an empty library. Your downloaded media files are untouched.`,
  })
}

export async function notifyStartupFailure(): Promise<void> {
  await showPlainMessageDialog({
    title: 'TapeBox could not start',
    message: 'TapeBox could not finish opening its settings and library.',
    detail: 'Nothing was changed. Check the session log, then start TapeBox again.',
  })
}
