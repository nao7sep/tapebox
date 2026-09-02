import { describe, expect, it, vi } from 'vitest'
import { loadMainWindowContent } from '@main/main-window-content'

describe('main window content', () => {
  it('preserves a hostile renderer load rejection for terminal startup recovery', async () => {
    const hostile = new Error('ERR_FILE_NOT_FOUND EACCES /private/tmp/TAPEBOX_RENDERER')
    const target = {
      loadURL: vi.fn(async () => undefined),
      loadFile: vi.fn(async () => { throw hostile }),
    }
    await expect(loadMainWindowContent(target, undefined, '/app/index.html')).rejects.toBe(hostile)
  })
})
