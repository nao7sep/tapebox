import { create } from 'zustand'
import type { Settings } from '@shared/settings'
import { ipcInvoke } from '@renderer/ipc/client'
import { presentFailure } from '@renderer/lib/presentFailure'

export type WritablePlaybackSetting = 'autoplay' | 'playSound'

/**
 * Renderer-side mirror of the persisted Settings, hydrated once at app startup
 * and refreshed whenever the Settings modal saves. It remains null until the
 * required app hydration commits, so consumers cannot render guessed values as
 * persisted preferences.
 */
type SettingsState = {
  settings: Settings | null
  writeErrors: Partial<Record<WritablePlaybackSetting, string>>
  saving: Partial<Record<WritablePlaybackSetting, boolean>>
  setSettings: (settings: Settings) => void
  setHydratedSettings: (settings: Settings) => void
  setWriteError: (field: WritablePlaybackSetting, message: string | null) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  writeErrors: {},
  saving: {},
  setSettings: (settings) => set({ settings }),
  setHydratedSettings: (settings) => set({ settings, writeErrors: {}, saving: {} }),
  setWriteError: (field, message) => set((state) => {
    const writeErrors = { ...state.writeErrors }
    if (message === null) delete writeErrors[field]
    else writeErrors[field] = message
    return { writeErrors }
  }),
}))

const FAILURE_COPY: Record<WritablePlaybackSetting, string> = {
  autoplay: 'The autoplay setting was not saved. The previous setting remains in use; try again.',
  playSound: 'The sound setting was not saved. The previous setting remains in use; try again.',
}

/**
 * Patch an app-chrome playback setting. Persisted changes are published only
 * after settings:update confirms them; a rejected write leaves the prior value
 * in use and retains a field-specific result beside the toggles.
 * (Window geometry and the live playback volume are view state, not settings, and
 * have their own store — see store/layout.ts.)
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
    const confirmed = await ipcInvoke('settings:update', patch)
    const current = useSettingsStore.getState().settings
    if (current) {
      const confirmedPatch: Partial<Settings> = {}
      for (const field of fields) Object.assign(confirmedPatch, { [field]: confirmed[field] })
      useSettingsStore.getState().setSettings({ ...current, ...confirmedPatch })
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
