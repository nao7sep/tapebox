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

  it('places further choices after the dismiss button, draws a destructive one as such, and wraps them rather than clip', () => {
    const html = renderPlainMessageDialogHtml({
      language: 'de',
      title: 't',
      message: 'm',
      closeLabel: 'Abbrechen',
      actions: [{ id: 'retry', label: 'Erneut versuchen' }, { id: 'quit-anyway', label: 'Trotzdem beenden', danger: true }],
    })
    const document = new DOMParser().parseFromString(html, 'text/html')
    const buttons = [...document.querySelectorAll('#dialog-footer button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['Abbrechen', 'Erneut versuchen', 'Trotzdem beenden'])
    expect(buttons[0]?.id).toBe('close')
    expect(buttons.map((button) => button.classList.contains('danger'))).toEqual([false, false, true])
    expect(buttons[2]?.getAttribute('onclick')).toBe("location.href='https://tapebox-dialog.invalid/choose/quit-anyway'")
    const style = document.querySelector('style')?.textContent ?? ''
    expect(style).toMatch(/\.actions\{[^}]*flex-wrap:wrap/)
    expect(style).toMatch(/\.button\{max-width:100%;overflow-wrap:anywhere/)
  })
})
