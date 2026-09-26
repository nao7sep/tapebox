import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { Translator } from '@shared/i18n/translate'

const APP_NAME = 'TapeBox'

/**
 * The application menu, in the interface language (localization-conventions,
 * app-chrome-conventions). It is Electron's default menu rebuilt with catalogue
 * labels, because the default's labels are English: the same roles, so every
 * item still sends the system's standard action to whatever has focus, and the
 * Window menu stays the windows menu macOS lists open windows in. The default's
 * Help menu, which only linked to Electron's own website, is left out.
 *
 * Built from the `nativeMenu.*` keys and rebuilt when the language changes.
 */
export function applicationMenuTemplate(t: Translator, platform: string): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin'
  const item = (role: MenuItemConstructorOptions['role'], label: string): MenuItemConstructorOptions => ({ role, label })
  const separator: MenuItemConstructorOptions = { type: 'separator' }

  const appMenu: MenuItemConstructorOptions = {
    label: APP_NAME,
    role: 'appMenu',
    submenu: [
      item('about', t.t('nativeMenu.about', { app: APP_NAME })),
      separator,
      item('services', t.t('nativeMenu.services')),
      separator,
      item('hide', t.t('nativeMenu.hide', { app: APP_NAME })),
      item('hideOthers', t.t('nativeMenu.hideOthers')),
      item('unhide', t.t('nativeMenu.showAll')),
      separator,
      item('quit', t.t('nativeMenu.quit', { app: APP_NAME })),
    ],
  }

  const fileMenu: MenuItemConstructorOptions = {
    label: t.t('nativeMenu.file'),
    role: 'fileMenu',
    submenu: [mac ? item('close', t.t('nativeMenu.closeWindow')) : item('quit', t.t('nativeMenu.exit'))],
  }

  // AppKit adds Emoji & Symbols, Start Dictation, AutoFill and Writing Tools to
  // this menu whatever it is titled, so its title follows the interface too.
  const editMenu: MenuItemConstructorOptions = {
    label: t.t('nativeMenu.edit'),
    role: 'editMenu',
    submenu: [
      item('undo', t.t('nativeMenu.undo')),
      item('redo', t.t('nativeMenu.redo')),
      separator,
      item('cut', t.t('nativeMenu.cut')),
      item('copy', t.t('nativeMenu.copy')),
      item('paste', t.t('nativeMenu.paste')),
      ...(mac
        ? [
            item('pasteAndMatchStyle', t.t('nativeMenu.pasteAndMatchStyle')),
            item('delete', t.t('nativeMenu.delete')),
            item('selectAll', t.t('nativeMenu.selectAll')),
            separator,
            {
              label: t.t('nativeMenu.speech'),
              submenu: [
                item('startSpeaking', t.t('nativeMenu.startSpeaking')),
                item('stopSpeaking', t.t('nativeMenu.stopSpeaking')),
              ],
            },
          ]
        : [item('delete', t.t('nativeMenu.delete')), separator, item('selectAll', t.t('nativeMenu.selectAll'))]),
    ],
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: t.t('nativeMenu.view'),
    role: 'viewMenu',
    submenu: [
      item('reload', t.t('nativeMenu.reload')),
      item('forceReload', t.t('nativeMenu.forceReload')),
      item('toggleDevTools', t.t('nativeMenu.toggleDevTools')),
      separator,
      item('resetZoom', t.t('nativeMenu.actualSize')),
      item('zoomIn', t.t('nativeMenu.zoomIn')),
      item('zoomOut', t.t('nativeMenu.zoomOut')),
      separator,
      item('togglefullscreen', t.t('nativeMenu.fullscreen')),
    ],
  }

  const windowMenu: MenuItemConstructorOptions = {
    label: t.t('nativeMenu.window'),
    role: 'windowMenu',
    submenu: [
      item('minimize', t.t('nativeMenu.minimize')),
      item('zoom', t.t('nativeMenu.zoom')),
      ...(mac ? [separator, item('front', t.t('nativeMenu.bringAllToFront'))] : [item('close', t.t('nativeMenu.close'))]),
    ],
  }

  return [...(mac ? [appMenu] : []), fileMenu, editMenu, viewMenu, windowMenu]
}

export function installApplicationMenu(t: Translator): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(t, process.platform)))
}
