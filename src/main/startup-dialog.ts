import { showPlainMessageDialog } from './plain-message-dialog.js'
import { mainTranslator } from './i18n.js'
import type { BrowserWindow } from 'electron'

/**
 * App-authored recovery surfaces shown during startup. They deliberately avoid
 * framework message boxes, whose platform artwork can reintroduce a redundant
 * severity or application icon. Each speaks the interface language, which is
 * settled before the app is ready, so even a failure to load settings is told
 * in the saved language.
 */

type Notice = 'settingsUnreadable' | 'libraryUnreadable' | 'failed'

async function showNotice(notice: Notice, owner?: BrowserWindow): Promise<void> {
  const t = mainTranslator()
  await showPlainMessageDialog({
    owner,
    language: t.language,
    title: t.t(`startup.${notice}.title`),
    message: t.t(`startup.${notice}.message`),
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

export async function notifyStartupFailure(): Promise<void> {
  await showNotice('failed')
}
