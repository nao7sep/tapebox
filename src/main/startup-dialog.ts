import { showPlainMessageDialog } from './plain-message-dialog.js'
import { mainTranslator } from './i18n.js'
import { NewerFormatError } from './io/format-version.js'
import { LibraryFolderSettingError, StoreAccessError } from './io/store-access.js'
import type { MessageValues } from '@shared/i18n/translate'
import type { BrowserWindow } from 'electron'

/**
 * App-authored recovery surfaces shown during startup. They deliberately avoid
 * framework message boxes, whose platform artwork can reintroduce a redundant
 * severity or application icon. Each speaks the interface language, which is
 * settled before the app is ready, so even a failure to load settings is told
 * in the saved language.
 */

type Notice =
  | 'settingsUnreadable' | 'libraryUnreadable' | 'settingsKept'
  | 'failed' | 'storeNewer' | 'storeInaccessible' | 'libraryFolderUnreadable'

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

/** A store set aside and reset is named by where its bytes now are, beside what
 *  the app started with instead (store-recovery-conventions). */
export async function notifyCorruptConfig(quarantinePath: string, owner?: BrowserWindow): Promise<void> {
  await showNotice('settingsUnreadable', owner, { path: quarantinePath })
}

export async function notifyCorruptSession(quarantinePath: string, owner?: BrowserWindow): Promise<void> {
  await showNotice('libraryUnreadable', owner, { path: quarantinePath })
}

/** Settings that failed their check stay in the file while the built-ins stand
 *  in for them (config-sets-conventions, Loading and fallback). */
export async function notifySettingsKept(configPath: string, owner?: BrowserWindow): Promise<void> {
  await showNotice('settingsKept', owner, { path: configPath })
}

/** Startup stopped. A store in a newer format, one that could not be opened, and
 *  a library folder setting that could not be read are each named with their
 *  path, and were left as they are (store-recovery-conventions). */
export async function notifyStartupFailure(error: unknown): Promise<void> {
  if (error instanceof NewerFormatError) await showNotice('storeNewer', undefined, { path: error.path })
  else if (error instanceof StoreAccessError) await showNotice('storeInaccessible', undefined, { path: error.path })
  else if (error instanceof LibraryFolderSettingError) await showNotice('libraryFolderUnreadable', undefined, { path: error.path })
  else await showNotice('failed')
}
