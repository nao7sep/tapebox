import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Box } from '@shared/domain'

const handlers = new Map<string, (req: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, (req) => fn({}, req))
    },
  },
}))

const state = vi.hoisted(() => ({ boxes: [] as Box[] }))
vi.mock('@main/store/session', () => ({
  getBoxes: () => state.boxes,
  getTapes: () => [],
  upsertBox: vi.fn((box: Box) => {
    state.boxes = [...state.boxes.filter((candidate) => candidate.id !== box.id), box]
  }),
  removeBox: vi.fn(),
  upsertTape: vi.fn(),
}))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))
vi.mock('@main/io/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { registerBoxHandlers } = await import('@main/ipc/boxes')

function invoke<T>(channel: string, req: unknown): Promise<T> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`${channel} was not registered`)
  return Promise.resolve(handler(req) as T)
}

beforeEach(() => {
  handlers.clear()
  state.boxes = [
    { id: 'box1234567', name: 'Caf\u00e9', order: 0 },
    { id: 'box7654321', name: 'Other', order: 1 },
  ]
  registerBoxHandlers()
})

describe('box-name canonical identity', () => {
  it('rejects a rename that differs from an existing name only by Unicode composition', async () => {
    await expect(
      invoke('boxes:rename', { boxId: 'box7654321', name: 'Cafe\u0301' }),
    ).rejects.toThrow(/already exists/)
  })

  it('creates an NFC-normalized unique name when the requested identity is taken', async () => {
    const created = await invoke<Box>('boxes:create', { name: 'Cafe\u0301' })

    expect(created.name).toBe('Caf\u00e9 2')
    expect(created.name).toBe(created.name.normalize('NFC'))
  })
})
