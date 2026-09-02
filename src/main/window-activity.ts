import type { App, BrowserWindow } from 'electron'
import { WINDOW_ACTIVITY_CHANNEL } from '@shared/window-activity'

/**
 * Project native application activation and owner-window focus into a renderer.
 * On macOS a BrowserWindow can remain focused after the application resigns
 * active status, so neither BrowserWindow nor DOM focus is sufficient alone.
 */
export function configureWindowActivity(application: App, window: BrowserWindow): void {
  let applicationActive = application.isActive()
  let windowFocused = window.isFocused()

  const send = (): void => {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(WINDOW_ACTIVITY_CHANNEL, applicationActive && windowFocused)
    }
  }
  const onApplicationActive = (): void => {
    applicationActive = true
    windowFocused = window.isFocused()
    send()
  }
  const onApplicationInactive = (): void => {
    applicationActive = false
    send()
  }

  application.on('did-become-active', onApplicationActive)
  application.on('did-resign-active', onApplicationInactive)
  window.on('focus', () => {
    windowFocused = true
    send()
  })
  window.on('blur', () => {
    windowFocused = false
    send()
  })
  window.webContents.on('did-finish-load', send)
  window.once('closed', () => {
    application.removeListener('did-become-active', onApplicationActive)
    application.removeListener('did-resign-active', onApplicationInactive)
  })
}
