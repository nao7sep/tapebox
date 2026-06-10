import type { LogFields, LogLevel } from '@shared/log'
import type { TapeboxApi } from '@shared/bridge'

/**
 * Renderer-side logger. The renderer is sandboxed and never opens the session
 * file; it forwards each structured log object to the main process (preload's
 * one-way `log` bridge), which writes it. Mirrors main's `log` surface so call
 * sites read the same on both sides.
 *
 * debug is gated here too, symmetric with main: when main reports debug off (a
 * packaged release), debug lines are dropped before crossing the IPC boundary,
 * so we never structured-clone and dispatch a line main would only discard.
 *
 * Forwarding is best-effort: if the bridge is somehow unavailable (e.g. imported
 * before preload attached) we fall back to the renderer console rather than throw
 * or silently drop — logging must never swallow its own failure.
 */

const bridge = (window as unknown as { tapebox: TapeboxApi }).tapebox

function forward(level: LogLevel, message: string, fields?: LogFields): void {
  try {
    if (level === 'debug' && !bridge.isDebugEnabled) return
    bridge.log({ level, message, fields })
  } catch (err) {
    try {
      console.error('log forward failed', err, { level, message, fields })
    } catch {
      // nothing left to try
    }
  }
}

export const log = {
  debug: (message: string, fields?: LogFields) => forward('debug', message, fields),
  info: (message: string, fields?: LogFields) => forward('info', message, fields),
  warn: (message: string, fields?: LogFields) => forward('warn', message, fields),
  error: (message: string, fields?: LogFields) => forward('error', message, fields),
}
