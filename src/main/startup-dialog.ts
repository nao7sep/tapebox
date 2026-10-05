import { showPlainMessageDialog } from './plain-message-dialog.js'
import { mainTranslator } from './i18n.js'
import { NewerFormatError } from './io/format-version.js'
import type { MessageValues } from '@shared/i18n/translate'
import type { BrowserWindow } from 'electron'

/**
 * App-authored recovery surfaces shown during startup. They deliberately avoid
 * framework message boxes, whose platform artwork can reintroduce a redundant
 * severity or application icon. Each speaks the interface language, which is
 * settled before the app is ready, so even a failure to load settings is told
 * in the saved language.
 */

type Notice = 'settingsUnreadable' | 'libraryUnreadable' | 'failed' | 'storeNewer'

async function showNotice(notice: Notice, owner?: BrowserWindow, values?: MessageValues): Promise<void> {
  const t = mainTranslator()
  await showPlainMessageDialog({
    owner,
    language: t.language,
    title: t.t(`startup.${notice}.title`),
    message: t.t(`startup.${notice}.message`, values),
    detail: t.t(`startup.${notice}.detail`),
    closeLabel: t.t('common.ok'),
  })
}

export async function notifyCorruptConfig(owner?: BrowserWindow): Promise<void> {
  await showNotice('settingsUnreadable', owner)
}

export async function notifyCorruptSession(owner?: BrowserWindow): Promise<void> {
  await showNotice('libraryUnreadable', owner)
}

/** Startup stopped. A store in a newer format is named with its path, and was
 *  left as it is (store-recovery-conventions). */
export async function notifyStartupFailure(error: unknown): Promise<void> {
  if (error instanceof NewerFormatError) await showNotice('storeNewer', undefined, { path: error.path })
  else await showNotice('failed')
}
