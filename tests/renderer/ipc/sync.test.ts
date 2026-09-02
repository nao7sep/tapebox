import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultLayout } from '@shared/layout'
import { defaultSettings } from '@shared/settings'

const { ipcInvoke, ipcOn } = vi.hoisted(() => ({ ipcInvoke: vi.fn(), ipcOn: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke, ipcOn }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn() } }))

import { applyInitialSyncState, pullInitialSyncState } from '@renderer/ipc/sync'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useBinariesStore } from '@renderer/store/binaries'
import { useRuntimeStore } from '@renderer/store/runtime'
import { useMediaStore } from '@renderer/store/media'
import { useLayoutStore } from '@renderer/store/layout'
import { useSettingsStore } from '@renderer/store/settings'

beforeEach(() => {
  ipcInvoke.mockReset()
  useTapesStore.setState({ tapes: [], progress: {} })
  useBoxesStore.setState({ boxes: [] })
  useBinariesStore.setState({ statuses: [] })
  useRuntimeStore.setState({ info: null })
  useMediaStore.setState({ baseUrl: null })
  useLayoutStore.setState({ layout: null, persistedLayout: null, writeErrors: {} })
  useSettingsStore.setState({ settings: null, writeErrors: {}, saving: {} })
})

describe('required renderer hydration', () => {
  it('does not publish false defaults or partial snapshots when one pull rejects', async () => {
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === 'layout:get') {
        return Promise.reject(new Error('EACCES /private/tmp/TAPEBOX_HYDRATION_SENTINEL'))
      }
      const values: Record<string, unknown> = {
        'library:list': [],
        'boxes:list': [],
        'binaries:status': [],
        'app:runtimeInfo': { platform: 'darwin', arch: 'arm64', version: '1.0.0' },
        'media:endpoint': { baseUrl: 'http://127.0.0.1:1234' },
        'settings:get': defaultSettings(),
      }
      return Promise.resolve(values[channel])
    })

    await expect(pullInitialSyncState()).rejects.toThrow('TAPEBOX_HYDRATION_SENTINEL')
    expect(useMediaStore.getState().baseUrl).toBeNull()
    expect(useLayoutStore.getState().layout).toBeNull()
    expect(useSettingsStore.getState().settings).toBeNull()
    expect(useRuntimeStore.getState().info).toBeNull()
  })

  it('commits the complete snapshot together after every required pull succeeds', async () => {
    const settings = defaultSettings()
    ipcInvoke.mockImplementation((channel: string) => Promise.resolve({
      'library:list': [],
      'boxes:list': [],
      'binaries:status': [],
      'app:runtimeInfo': { platform: 'darwin', arch: 'arm64', version: '1.0.0' },
      'media:endpoint': { baseUrl: 'http://127.0.0.1:1234' },
      'layout:get': defaultLayout,
      'settings:get': settings,
    }[channel]))

    const snapshot = await pullInitialSyncState()
    applyInitialSyncState(snapshot)

    expect(useMediaStore.getState().baseUrl).toBe('http://127.0.0.1:1234')
    expect(useLayoutStore.getState().layout).toEqual(defaultLayout)
    expect(useLayoutStore.getState().persistedLayout).toEqual(defaultLayout)
    expect(useSettingsStore.getState().settings).toEqual(settings)
    expect(useRuntimeStore.getState().info?.platform).toBe('darwin')
  })
})
