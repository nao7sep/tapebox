import { create } from 'zustand'
import type { Settings } from '@shared/settings'
import { ipcInvoke } from '@renderer/ipc/client'

/**
 * Renderer-side mirror of the persisted Settings, hydrated once at app startup
 * and refreshed whenever the Settings modal saves. Player and removal flows
 * read their preferences from here synchronously. Null until hydrated, so
 * consumers fall back to a sensible default (e.g. `settings?.autoplay ?? true`).
 */
type SettingsState = {
  settings: Settings | null
  setSettings: (settings: Settings) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  setSettings: (settings) => set({ settings }),
}))

/**
 * Patch one or more settings. With persist=false the change is applied only to
 * the in-memory mirror — used for smooth live dragging without a disk write per
 * pixel. With persist=true it is also saved via settings:update; the disk write
 * merges, so omitting other fields never clobbers them. Both the layout drags and
 * the playback toggles flow through here, so every surface stays in sync.
 */
export function patchSettings(patch: Partial<Settings>, persist: boolean): void {
  const cur = useSettingsStore.getState().settings
  if (cur) useSettingsStore.getState().setSettings({ ...cur, ...patch })
  if (persist) {
    void ipcInvoke('settings:update', patch).then((s) => useSettingsStore.getState().setSettings(s))
  }
}
