import { ipcMain } from 'electron'
import { parseLogMessage } from '@shared/log'
import { getDebugEnabled, log } from '@main/io/logger'

/**
 * Thin IPC adapter for renderer logging — the renderer cannot open the session
 * file, so it forwards structured log objects to main, which writes them. The
 * validation that keeps a misbehaving renderer from wedging logging lives in the
 * pure parseLogMessage (src/shared/log.ts); here we only bridge IPC to the
 * logger. Every renderer line is tagged source:"renderer" so a reader can tell
 * vantage points apart; debug gating and redaction still happen in the logger.
 *
 * The 'log:debug-enabled' synchronous reply lets the preload learn main's debug
 * state once at startup, so the renderer can skip forwarding debug lines that a
 * packaged release would only drop.
 */
export function registerLogHandlers(): void {
  ipcMain.on('log:write', (_event, payload: unknown) => {
    const msg = parseLogMessage(payload)
    if (!msg) return
    log[msg.level](msg.message, { ...msg.fields, source: 'renderer' })
  })

  ipcMain.on('log:debug-enabled', (event) => {
    event.returnValue = getDebugEnabled()
  })
}
