import { ipcMain } from 'electron'
import { parseLogMessage } from '@shared/log'
import { LOG_DEBUG_ENABLED_CHANNEL, LOG_WRITE_CHANNEL } from '@shared/log-channels'
import { getDebugEnabled, log } from '@main/io/logger'

/**
 * Thin IPC adapter for renderer logging — the renderer cannot open the records
 * database, so it forwards structured log objects to main, which writes them. The
 * validation that keeps a misbehaving renderer from wedging logging lives in the
 * pure parseLogMessage (src/shared/log.ts); here we only bridge IPC to the
 * logger. Every renderer line is tagged source:"renderer" so a reader can tell
 * vantage points apart; debug gating still happens in the logger.
 *
 * The debug-enabled synchronous reply lets the preload learn main's debug
 * state once at startup, so the renderer can skip forwarding debug lines that a
 * packaged release would only drop.
 */
export function registerLogHandlers(): void {
  ipcMain.on(LOG_WRITE_CHANNEL, (_event, payload: unknown) => {
    const msg = parseLogMessage(payload)
    if (!msg) return
    log[msg.level](msg.message, { ...msg.fields, source: 'renderer' })
  })

  ipcMain.on(LOG_DEBUG_ENABLED_CHANNEL, (event) => {
    event.returnValue = getDebugEnabled()
  })
}
