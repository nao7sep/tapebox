import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'

const documents = new WeakMap<WebContents, string>()

/** Register before loading, so the document's preload can make synchronous calls.
 * Only app-created privileged windows receive a registration. */
export function trustApplicationDocument(contents: WebContents, url: string): void {
  const document = new URL(url).href
  documents.set(contents, document)
  const preventDeparture = (event: Electron.Event, destination: string): void => {
    if (destination !== document) event.preventDefault()
  }
  contents.on('will-navigate', preventDeparture)
  contents.on('will-redirect', preventDeparture)
}

/** Payload validation is separate: even a well-formed request needs a live,
 * registered top-level document. A same-origin child frame is not its owner. */
export function isTrustedApplicationSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const { sender, senderFrame } = event
  return !sender.isDestroyed()
    && senderFrame !== null
    && senderFrame === sender.mainFrame
    && documents.get(sender) === senderFrame.url
}
