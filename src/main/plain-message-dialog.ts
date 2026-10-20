import { BrowserWindow } from 'electron'
import { THEME_TOKENS, windowBackground } from './theme'
import { log } from './io/logger'
import { describeError } from '@shared/error'

export interface PlainMessageDialogOptions {
  owner?: BrowserWindow
  /** The interface language the words are in, declared as the page's lang. */
  language: string
  title: string
  message: string
  detail?: string
  /** The dismiss button, first in the footer and focused when the dialog opens. */
  closeLabel: string
  /** Further choices after the dismiss button, in footer order. */
  actions?: readonly PlainMessageDialogAction[]
  /** Closes the dialog as dismissed, such as when the OS session ends. */
  signal?: AbortSignal
}

export interface PlainMessageDialogAction {
  id: string
  label: string
  /** A destructive choice, drawn as one. */
  danger?: boolean
}

const CLOSE_URL = 'https://tapebox-dialog.invalid/close'
const CHOOSE_URL = 'https://tapebox-dialog.invalid/choose/'

/** App-authored message shell without native severity/application artwork.
 * Resolves with the chosen action's id, or null when it was dismissed. */
export async function showPlainMessageDialog(options: PlainMessageDialogOptions): Promise<string | null> {
  if (options.signal?.aborted) return null
  const parent = options.owner ?? BrowserWindow.getFocusedWindow() ?? undefined
  const win = new BrowserWindow({
    parent,
    modal: Boolean(parent),
    show: false,
    width: 520,
    height: 260,
    minWidth: 420,
    minHeight: 220,
    maxWidth: 680,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: options.title,
    // The page follows prefers-color-scheme, which follows nativeTheme.themeSource
    // (the OS when startup failed before settings were read).
    backgroundColor: windowBackground(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  return await new Promise<string | null>((resolve) => {
    let settled = false
    const close = (choice: string | null = null): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', dismiss)
      resolve(choice)
      if (!win.isDestroyed()) win.close()
    }
    const dismiss = (): void => close()
    options.signal?.addEventListener('abort', dismiss)
    const settleLoadFailure = (phase: string, error: unknown): void => {
      log.error(`message dialog ${phase} failed`, { error: describeError(error) })
      close()
    }
    win.on('closed', dismiss)
    win.webContents.on('will-navigate', (event, url) => {
      if (url === CLOSE_URL) {
        event.preventDefault()
        close()
        return
      }
      if (!url.startsWith(CHOOSE_URL)) return
      event.preventDefault()
      const id = decodeURIComponent(url.slice(CHOOSE_URL.length))
      close(options.actions?.some((action) => action.id === id) ? id : null)
    })
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key !== 'Escape') return
      event.preventDefault()
      close()
    })
    win.webContents.once('dom-ready', () => {
      void win.webContents.executeJavaScript(
        "document.getElementById('dialog-header').offsetHeight + document.getElementById('dialog-body').scrollHeight + document.getElementById('dialog-footer').offsetHeight",
        true,
      )
        .then((height: number) => {
          if (win.isDestroyed()) return
          const displayHeight = parent?.getBounds().height ?? 900
          win.setContentSize(520, Math.min(Math.max(Math.ceil(height), 220), Math.floor(displayHeight * 0.85)))
          win.show()
          return win.webContents.executeJavaScript("document.getElementById('close')?.focus()", true)
        })
        .catch((error: unknown) => settleLoadFailure('measurement', error))
    })
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderPlainMessageDialogHtml(options))}`)
      .catch((error: unknown) => settleLoadFailure('load', error))
  })
}

// The renderer's tokens the dialog paints with, in each theme (THEME_TOKENS).
const DIALOG_TOKENS = [
  '--color-canvas', '--color-fg-strong', '--color-fg-muted', '--color-fg-emphasis', '--color-control-line',
  '--color-raised', '--color-raised-hover', '--color-focus', '--color-danger-fill', '--color-danger-fill-hover',
  '--color-on-danger',
] as const

function tokenDeclarations(theme: 'light' | 'dark'): string {
  return DIALOG_TOKENS.map((name) => `${name}:${THEME_TOKENS[theme][name]}`).join(';')
}

export function renderPlainMessageDialogHtml(options: PlainMessageDialogOptions): string {
  return `<!doctype html><html lang="${escapeHtml(options.language)}"><head><meta charset="utf-8"><style>
    :root{color-scheme:light;${tokenDeclarations('light')}}
    @media (prefers-color-scheme:dark){:root{color-scheme:dark;${tokenDeclarations('dark')}}}
    :root{font:14px/1.5 system-ui,-apple-system,sans-serif;background:var(--color-canvas);color:var(--color-fg-strong)}
    *{box-sizing:border-box}body{margin:0;height:100vh;overflow:hidden}.dialog{height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr) auto}
    .header{padding:24px 24px 12px}.body{min-height:0;overflow:auto;padding:0 24px;display:flex;flex-direction:column;gap:12px}
    h1{font-size:18px;line-height:1.3;margin:0}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.detail{color:var(--color-fg-muted)}
    .actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:12px 24px 24px}.button{max-width:100%;overflow-wrap:anywhere;color:var(--color-fg-emphasis);border:1px solid var(--color-control-line);border-radius:6px;padding:7px 16px;background:var(--color-raised);font:inherit}.button:hover,.button:focus{background:var(--color-raised-hover);outline:2px solid var(--color-focus);outline-offset:2px}
    .button.danger{color:var(--color-on-danger);border-color:var(--color-danger-fill);background:var(--color-danger-fill);font-weight:500}.button.danger:hover,.button.danger:focus{background:var(--color-danger-fill-hover)}
  </style></head><body><main class="dialog"><header class="header" id="dialog-header"><h1>${escapeHtml(options.title)}</h1></header><section class="body" id="dialog-body"><p>${escapeHtml(options.message)}</p>${options.detail ? `<p class="detail">${escapeHtml(options.detail)}</p>` : ''}</section><footer class="actions" id="dialog-footer"><button id="close" class="button" type="button" onclick="location.href='${CLOSE_URL}'">${escapeHtml(options.closeLabel)}</button>${(options.actions ?? []).map(renderAction).join('')}</footer></main></body></html>`
}

function renderAction(action: PlainMessageDialogAction): string {
  const url = `${CHOOSE_URL}${encodeURIComponent(action.id)}`
  return `<button class="button${action.danger ? ' danger' : ''}" type="button" onclick="location.href='${escapeHtml(url)}'">${escapeHtml(action.label)}</button>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}
