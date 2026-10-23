import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { isTrustedApplicationSender, trustApplicationDocument } from '@main/ipc/trust'

function windowDocument(url: string) {
  const frame = { url }
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: (): boolean => false })
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return { contents, frame, event, register: () => trustApplicationDocument(contents as unknown as WebContents, url) }
}

describe('application document authority', () => {
  it.each(['file:///app/index.html', 'file:///app/records.html', 'http://localhost:5173/'])('admits only the registered live top-level document: %s', (url) => {
    const window = windowDocument(url)
    expect(isTrustedApplicationSender(window.event)).toBe(false)
    window.register()
    expect(isTrustedApplicationSender(window.event)).toBe(true)
    expect(isTrustedApplicationSender({ ...window.event, senderFrame: { url } } as IpcMainInvokeEvent)).toBe(false)
    expect(isTrustedApplicationSender({ ...window.event, senderFrame: null })).toBe(false)
    window.frame.url = `${url}?foreign-document`
    expect(isTrustedApplicationSender(window.event)).toBe(false)
    window.frame.url = url
    window.contents.isDestroyed = () => true
    expect(isTrustedApplicationSender(window.event)).toBe(false)
  })

  it.each(['will-navigate', 'will-redirect'])('prevents document departure through %s while allowing reload', (eventName) => {
    const window = windowDocument('file:///app/index.html')
    window.register()
    let prevented = false
    const event = { preventDefault: () => { prevented = true } }
    window.contents.emit(eventName, event, 'file:///app/index.html')
    expect(prevented).toBe(false)
    window.contents.emit(eventName, event, 'https://foreign.example/')
    expect(prevented).toBe(true)
  })
})
