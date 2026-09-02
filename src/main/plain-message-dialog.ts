import { BrowserWindow } from 'electron'

export interface PlainMessageDialogOptions {
  title: string
  message: string
  detail?: string
}

const CLOSE_URL = 'https://tapebox-dialog.invalid/close'

/** App-authored message shell without native severity/application artwork. */
export async function showPlainMessageDialog(options: PlainMessageDialogOptions): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow() ?? undefined
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
    backgroundColor: '#09090b',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  await new Promise<void>((resolve) => {
    let settled = false
    const close = (): void => {
      if (settled) return
      settled = true
      resolve()
      if (!win.isDestroyed()) win.close()
    }
    win.on('closed', close)
    win.webContents.on('will-navigate', (event, url) => {
      if (url !== CLOSE_URL) return
      event.preventDefault()
      close()
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
    })
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderPlainMessageDialogHtml(options))}`)
  })
}

export function renderPlainMessageDialogHtml(options: PlainMessageDialogOptions): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:dark;font:14px/1.5 system-ui,-apple-system,sans-serif;background:#09090b;color:#f4f4f5}
    *{box-sizing:border-box}body{margin:0;height:100vh;overflow:hidden}.dialog{height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr) auto}
    .header{padding:24px 24px 12px}.body{min-height:0;overflow:auto;padding:0 24px;display:flex;flex-direction:column;gap:12px}
    h1{font-size:18px;line-height:1.3;margin:0}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.detail{color:#a1a1aa}
    .actions{display:flex;justify-content:flex-end;padding:12px 24px 24px}.button{color:#f4f4f5;border:1px solid #3f3f46;border-radius:6px;padding:7px 16px;background:#27272a;font:inherit}.button:hover,.button:focus{background:#3f3f46;outline:2px solid #a1a1aa;outline-offset:2px}
  </style></head><body><main class="dialog"><header class="header" id="dialog-header"><h1>${escapeHtml(options.title)}</h1></header><section class="body" id="dialog-body"><p>${escapeHtml(options.message)}</p>${options.detail ? `<p class="detail">${escapeHtml(options.detail)}</p>` : ''}</section><footer class="actions" id="dialog-footer"><button id="close" class="button" type="button" onclick="location.href='${CLOSE_URL}'">OK</button></footer></main></body></html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}
