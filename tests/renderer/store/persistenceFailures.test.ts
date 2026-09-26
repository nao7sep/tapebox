import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultLayout } from '@shared/layout'
import { defaultSettings } from '@shared/settings'

const { ipcInvoke, logError } = vi.hoisted(() => ({ ipcInvoke: vi.fn(), logError: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: logError } }))

import { patchLayout, useLayoutStore } from '@renderer/store/layout'
import { savePlaybackSettings, useSettingsStore } from '@renderer/store/settings'

const HOSTILE = "Error invoking remote method 'layout:update': EACCES /private/tmp/TAPEBOX_WRITE_SENTINEL"

beforeEach(() => {
  ipcInvoke.mockReset()
  logError.mockReset()
  useLayoutStore.setState({
    layout: defaultLayout,
    persistedLayout: defaultLayout,
    writeErrors: {},
  })
  useSettingsStore.setState({
    settings: defaultSettings(),
    writeErrors: {},
    saving: {},
  })
})

describe('truthful renderer persistence', () => {
  it('rolls a rejected layout intent back and retains only authored field copy', async () => {
    ipcInvoke.mockRejectedValueOnce(new Error(HOSTILE))
    await patchLayout({ leftPaneWidth: 600 }, true)

    const state = useLayoutStore.getState()
    expect(state.layout?.leftPaneWidth).toBe(defaultLayout.leftPaneWidth)
    expect(state.persistedLayout?.leftPaneWidth).toBe(defaultLayout.leftPaneWidth)
    expect(state.writeErrors.leftPaneWidth).toBe(
      'The library pane size was not saved. Its previous size is back; try resizing it again.',
    )
    expect(state.writeErrors.leftPaneWidth).not.toMatch(/EACCES|private\/tmp|SENTINEL|remote method/i)
    expect(JSON.stringify(logError.mock.calls)).toContain('TAPEBOX_WRITE_SENTINEL')
  })

  it('does not project a rejected setting patch as the saved value', async () => {
    ipcInvoke.mockRejectedValueOnce(new Error(HOSTILE))
    await savePlaybackSettings({ autoplay: false })

    const state = useSettingsStore.getState()
    expect(state.settings?.autoplay).toBe(true)
    expect(state.saving.autoplay).toBeUndefined()
    expect(state.writeErrors.autoplay).toBe(
      'The autoplay setting was not saved. The previous setting remains in use; try again.',
    )
    expect(state.writeErrors.autoplay).not.toMatch(/EACCES|private\/tmp|SENTINEL|remote method/i)
  })

  it('settles unrelated setting writes independently when responses finish out of order', async () => {
    type Saved = { settings: ReturnType<typeof defaultSettings>; warning: string | null }
    let resolveAutoplay!: (value: Saved) => void
    let resolveSound!: (value: Saved) => void
    const autoplayResponse = new Promise<Saved>((resolve) => { resolveAutoplay = resolve })
    const soundResponse = new Promise<Saved>((resolve) => { resolveSound = resolve })
    ipcInvoke.mockReturnValueOnce(autoplayResponse).mockReturnValueOnce(soundResponse)

    const autoplayWrite = savePlaybackSettings({ autoplay: false })
    const soundWrite = savePlaybackSettings({ playSound: false })
    resolveSound({ settings: { ...defaultSettings(), playSound: false }, warning: null })
    await soundWrite
    resolveAutoplay({ settings: { ...defaultSettings(), autoplay: false }, warning: null })
    await autoplayWrite

    expect(useSettingsStore.getState().settings).toMatchObject({ autoplay: false, playSound: false })
  })

  it('keeps independent layout fields when one concurrent write rejects', async () => {
    let resolveLeft!: (value: typeof defaultLayout) => void
    let rejectVolume!: (error: Error) => void
    const leftResponse = new Promise<typeof defaultLayout>((resolve) => { resolveLeft = resolve })
    const volumeResponse = new Promise<typeof defaultLayout>((_resolve, reject) => { rejectVolume = reject })
    ipcInvoke.mockReturnValueOnce(leftResponse).mockReturnValueOnce(volumeResponse)

    const leftWrite = patchLayout({ leftPaneWidth: 500 }, true)
    const volumeWrite = patchLayout({ volume: 0.25 }, true)
    rejectVolume(new Error(HOSTILE))
    await volumeWrite
    resolveLeft({ ...defaultLayout, leftPaneWidth: 500 })
    await leftWrite

    expect(useLayoutStore.getState().layout).toMatchObject({ leftPaneWidth: 500, volume: defaultLayout.volume })
    expect(useLayoutStore.getState().writeErrors.leftPaneWidth).toBeUndefined()
    expect(useLayoutStore.getState().writeErrors.volume).toContain('playback volume was not saved')
  })
})
