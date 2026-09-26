// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: {} }))

import { renderPlainMessageDialogHtml } from '@main/plain-message-dialog'

describe('plain message dialog', () => {
  it('keeps its measured shell IDs and renders caller text without creating markup', () => {
    const html = renderPlainMessageDialogHtml({
      language: 'ja',
      closeLabel: 'OK',
      title: '<img src=x onerror=alert(1)>',
      message: 'Save & close',
      detail: '<script>alert(1)</script>',
    })
    const document = new DOMParser().parseFromString(html, 'text/html')

    expect(document.getElementById('dialog-header')?.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(document.getElementById('dialog-body')?.textContent).toBe('Save & close<script>alert(1)</script>')
    expect(document.getElementById('dialog-footer')).not.toBeNull()
    expect(document.getElementById('close')).not.toBeNull()
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
  })

  it('declares the interface language and labels its button in it', () => {
    const html = renderPlainMessageDialogHtml({
      language: 'ja',
      title: '設定を読み込めませんでした',
      message: 'm',
      closeLabel: 'OK',
    })
    const document = new DOMParser().parseFromString(html, 'text/html')
    expect(document.documentElement.lang).toBe('ja')
    expect(document.getElementById('close')?.textContent).toBe('OK')
  })
})
