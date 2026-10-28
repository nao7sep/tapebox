import { create } from 'zustand'
import type { Settings } from '@shared/settings'
import { ipcInvoke } from '@renderer/ipc/client'
import { presentFailure } from '@renderer/lib/presentFailure'
import { message, type Message } from '@shared/i18n/translate'

export type WritablePlaybackSetting = 'autoplay'
/** Playback settings saved from the app chrome, each with its own save result. */
export type PlaybackSettingField = WritablePlaybackSetting | 'volume'

/**
 * Renderer-side mirror of the persisted Settings, hydrated once at app startup
 * and refreshed whenever the Settings modal saves. It remains null until the
 * required app hydration commits, so consumers cannot render guessed values as
 * persisted preferences.
 */
type SettingsState = {
  settings: Settings | null
  /** The volume main last confirmed, restored when a later volume save fails. */
  appliedVolume: number | null
  writeErrors: Partial<Record<PlaybackSettingField, Message>>
  saving: Partial<Record<WritablePlaybackSetting, boolean>>
  setSettings: (settings: Settings) => void
  setHydratedSettings: (settings: Settings) => void
  setWriteError: (field: PlaybackSettingField, message: Message | null) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  appliedVolume: null,
  writeErrors: {},
  saving: {},
  setSettings: (settings) => set({ settings, appliedVolume: settings.volume }),
  setHydratedSettings: (settings) => set({ settings, appliedVolume: settings.volume, writeErrors: {}, saving: {} }),
  setWriteError: (field, message) => set((state) => {
    const writeErrors = { ...state.writeErrors }
    if (message === null) delete writeErrors[field]
    else writeErrors[field] = message
    return { writeErrors }
  }),
}))

const FAILURE_COPY: Record<WritablePlaybackSetting, Message> = {
  autoplay: message('playback.autoplaySaveFailed'),
}

let volumeRevision = 0

/**
 * Set the playback volume. persist=false updates the mirror at once, so a drag is
 * smooth and the next tape opens at the current level; persist=true saves it. A
 * failed save restores the last confirmed level, unless a newer change has
 * superseded it, and leaves a result beside the playback controls.
 */
export async function patchVolume(volume: number, persist: boolean): Promise<void> {
  const cur = useSettingsStore.getState().settings
  if (!cur) return
  const revision = ++volumeRevision
  useSettingsStore.setState({ settings: { ...cur, volume } })
  if (!persist) return
  useSettingsStore.getState().setWriteError('volume', null)
  try {
    const { settings: confirmed } = await ipcInvoke('settings:update', { volume })
    const current = useSettingsStore.getState().settings
    if (!current) return
    useSettingsStore.setState(revision === volumeRevision
      ? { settings: { ...current, volume: confirmed.volume }, appliedVolume: confirmed.volume }
      : { appliedVolume: confirmed.volume })
  } catch (error) {
    const state = useSettingsStore.getState()
    if (!state.settings || state.appliedVolume === null || revision !== volumeRevision) return
    useSettingsStore.setState({ settings: { ...state.settings, volume: state.appliedVolume } })
    state.setWriteError('volume', presentFailure(error, message('playback.volumeSaveFailed'), 'volume setting save failed'))
  }
}

/**
 * Patch an app-chrome playback setting. Persisted changes are published only
 * after settings:update confirms them; a rejected write leaves the prior value
 * in use and retains a field-specific result beside the toggles.
 * (The volume, adjusted by dragging, saves through patchVolume.)
 */
export async function savePlaybackSettings(
  patch: Partial<Pick<Settings, WritablePlaybackSetting>>,
): Promise<void> {
  const cur = useSettingsStore.getState().settings
  if (!cur) return
  const fields = Object.keys(patch) as WritablePlaybackSetting[]
  if (fields.some((field) => useSettingsStore.getState().saving[field])) return
  for (const field of fields) useSettingsStore.getState().setWriteError(field, null)
  useSettingsStore.setState((state) => ({
    saving: { ...state.saving, ...Object.fromEntries(fields.map((field) => [field, true])) },
  }))
  try {
    const { settings: confirmed } = await ipcInvoke('settings:update', patch)
    const current = useSettingsStore.getState().settings
    if (current) {
      const confirmedPatch: Partial<Settings> = {}
      for (const field of fields) Object.assign(confirmedPatch, { [field]: confirmed[field] })
      // setState, not setSettings: current may hold an unsaved volume mid-drag.
      useSettingsStore.setState({ settings: { ...current, ...confirmedPatch } })
    }
  } catch (error) {
    for (const field of fields) {
      useSettingsStore.getState().setWriteError(
        field,
        presentFailure(error, FAILURE_COPY[field], `${field} setting save failed`),
      )
    }
  } finally {
    useSettingsStore.setState((state) => {
      const saving = { ...state.saving }
      for (const field of fields) delete saving[field]
      return { saving }
    })
  }
}
