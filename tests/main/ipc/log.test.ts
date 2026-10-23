import { EventEmitter } from 'node:events'
import type { IpcMainEvent, WebContents } from 'electron'
import { expect, it, vi } from 'vitest'
import { LOG_DEBUG_ENABLED_CHANNEL, LOG_WRITE_CHANNEL } from '@shared/log-channels'
import { trustApplicationDocument } from '@main/ipc/trust'

const mocks = vi.hoisted(() => ({ on: vi.fn(), info: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { on: mocks.on } }))
vi.mock('@main/io/logger', () => ({ getDebugEnabled: () => true, log: { info: mocks.info } }))
import { registerLogHandlers } from '@main/ipc/log'

it('requires document authority for one-way logs and synchronous debug reads', () => {
  registerLogHandlers()
  const write = mocks.on.mock.calls.find(([channel]) => channel === LOG_WRITE_CHANNEL)![1]
  const read = mocks.on.mock.calls.find(([channel]) => channel === LOG_DEBUG_ENABLED_CHANNEL)![1]
  const senderFrame = { url: 'file:///app/index.html' }
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: senderFrame }) as unknown as WebContents
  const event = { sender, senderFrame } as IpcMainEvent
  const message = { level: 'info', message: 'renderer message', fields: {} }
  write(event, message)
  read(event)
  expect(mocks.info).not.toHaveBeenCalled()
  expect(event.returnValue).toBe(false)
  trustApplicationDocument(sender, senderFrame.url)
  write(event, message)
  read(event)
  expect(mocks.info).toHaveBeenCalledOnce()
  expect(event.returnValue).toBe(true)
})
