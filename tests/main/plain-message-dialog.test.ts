import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: {} }))

import { renderPlainMessageDialogHtml } from '@main/plain-message-dialog'

describe('plain message dialog', () => {
  it('keeps header and footer fixed while only the body scrolls', () => {
    const html = renderPlainMessageDialogHtml({ title: 'Title', message: 'Message', detail: 'Detail' })

    expect(html).toContain('id="dialog-header"')
    expect(html).toContain('id="dialog-body"')
    expect(html).toContain('id="dialog-footer"')
    expect(html).toContain('.body{min-height:0;overflow:auto')
    expect(html).toContain('body{margin:0;height:100vh;overflow:hidden}')
  })
})
