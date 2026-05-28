import { useEffect, useState } from 'react'
import type { AiProfile, Settings } from '@shared/settings'
import { ipcInvoke } from '@renderer/ipc/client'
import { useRuntimeStore } from '@renderer/store/runtime'

type Props = { onClose: () => void }

/**
 * Settings dialog covering the user-editable surfaces in v1:
 *   - Behavior (autostart, concurrency)
 *   - AI profiles (add/select/delete, set/clear API key)
 *
 * Library directory, binary update policies, and log retention are intentionally
 * left out of the UI for v1 — defaults are sensible; advanced users can edit
 * ~/.tapebox/config.json directly. Surfaced in a later phase if needed.
 */
export function SettingsDialog({ onClose }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const runtime = useRuntimeStore((s) => s.info)

  useEffect(() => {
    void ipcInvoke('settings:get').then(setSettings)
  }, [])

  if (!settings) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80">
        <div className="rounded bg-zinc-900 p-6 text-sm text-zinc-400">Loading…</div>
      </div>
    )
  }

  async function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    setBusy(true)
    setError(null)
    try {
      const next = await ipcInvoke('settings:update', { [key]: value } as Partial<Settings>)
      setSettings(next)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function setActiveProfile(id: string | null) {
    await updateSetting('activeAiProfileId', id)
  }

  async function addProfileFromSuggestion(p: AiProfile) {
    if (!settings) return
    if (settings.aiProfiles.some((x) => x.id === p.id)) return
    await updateSetting('aiProfiles', [...settings.aiProfiles, p])
  }

  async function addCustomProfile() {
    if (!settings) return
    const id = `custom-${Date.now()}`
    const created: AiProfile = {
      id,
      name: 'Custom',
      baseUrl: 'https://example.com/v1',
      model: 'model-id',
      kind: 'openai-compatible',
    }
    await updateSetting('aiProfiles', [...settings.aiProfiles, created])
  }

  async function updateProfile(id: string, patch: Partial<AiProfile>) {
    if (!settings) return
    await updateSetting(
      'aiProfiles',
      settings.aiProfiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    )
  }

  async function deleteProfile(id: string) {
    if (!settings) return
    setBusy(true)
    setError(null)
    try {
      await ipcInvoke('settings:clearApiKey', { profileId: id }).catch(() => {})
      const nextProfiles = settings.aiProfiles.filter((p) => p.id !== id)
      const next = await ipcInvoke('settings:update', {
        aiProfiles: nextProfiles,
        activeAiProfileId: settings.activeAiProfileId === id ? null : settings.activeAiProfileId,
      })
      setSettings(next)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm">
      <div className="flex h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl">
        <header className="flex shrink-0 items-center justify-between border-b border-zinc-800 p-4">
          <h2 className="text-base font-medium">Settings</h2>
          <button onClick={onClose} className="text-xs text-zinc-400 hover:text-zinc-100">Close</button>
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          <Section title="Behavior">
            <Toggle
              label="Autostart downloads"
              description="Newly added items start downloading immediately. Off = added as paused."
              checked={settings.autoStartDownloads}
              disabled={busy}
              onChange={(v) => updateSetting('autoStartDownloads', v)}
            />
            <NumberField
              label="Max concurrent downloads"
              value={settings.maxConcurrentDownloads}
              min={1}
              max={8}
              disabled={busy}
              onChange={(v) => updateSetting('maxConcurrentDownloads', v)}
            />
          </Section>

          <Section title="AI profiles" hint="Used for slug generation. Currently only OpenAI-compatible endpoints.">
            {runtime && !runtime.encryptionAvailable && (
              <div className="rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
                The OS keychain is unavailable on this system, so API keys can't be saved securely.
                {' '}
                {runtime.platform === 'linux'
                  ? 'Install libsecret (or gnome-keyring) and restart TapeBox.'
                  : 'Saving API keys is disabled until OS encryption becomes available.'}
              </div>
            )}
            <div className="space-y-2">
              {settings.aiProfiles.map((p) => (
                <ProfileRow
                  key={p.id}
                  profile={p}
                  active={p.id === settings.activeAiProfileId}
                  busy={busy}
                  canSaveKey={runtime?.encryptionAvailable ?? false}
                  onActive={() => setActiveProfile(p.id)}
                  onChange={(patch) => updateProfile(p.id, patch)}
                  onDelete={() => deleteProfile(p.id)}
                />
              ))}
              {settings.aiProfiles.length === 0 && (
                <p className="text-xs text-zinc-500">No profiles yet. Add one below.</p>
              )}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {presetButtons(settings.aiProfiles).map((p) => (
                <button
                  key={p.id}
                  onClick={() => addProfileFromSuggestion(p)}
                  disabled={busy}
                  className="rounded border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800 disabled:opacity-50"
                >
                  + {p.name} ({p.model})
                </button>
              ))}
              <button
                onClick={addCustomProfile}
                disabled={busy}
                className="rounded border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800 disabled:opacity-50"
              >
                + Custom
              </button>
            </div>
          </Section>

          {error && (
            <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function presetButtons(existing: AiProfile[]): AiProfile[] {
  const presets: AiProfile[] = [
    { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', kind: 'openai-compatible' },
    { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash-lite', kind: 'openai-compatible' },
  ]
  const existingIds = new Set(existing.map((p) => p.id))
  return presets.filter((p) => !existingIds.has(p.id))
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-300">{title}</h3>
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  )
}

function Toggle({ label, description, checked, disabled, onChange }: {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div>
        <div className="text-sm">{label}</div>
        {description && <div className="text-xs text-zinc-500">{description}</div>}
      </div>
    </label>
  )
}

function NumberField({ label, value, min, max, disabled, onChange }: {
  label: string
  value: number
  min: number
  max: number
  disabled?: boolean
  onChange: (v: number) => void
}) {
  return (
    <label className="flex items-center gap-3">
      <span className="text-sm">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Math.max(min, Math.min(max, parseInt(e.target.value || '1', 10))))}
        className="w-20 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm focus:border-zinc-600 focus:outline-none"
      />
    </label>
  )
}

function ProfileRow({ profile, active, busy, canSaveKey, onActive, onChange, onDelete }: {
  profile: AiProfile
  active: boolean
  busy: boolean
  canSaveKey: boolean
  onActive: () => void
  onChange: (patch: Partial<AiProfile>) => void
  onDelete: () => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyMsg, setKeyMsg] = useState<string | null>(null)

  async function saveKey() {
    if (!apiKey.trim()) return
    setKeyBusy(true)
    setKeyMsg(null)
    try {
      await ipcInvoke('settings:setApiKey', { profileId: profile.id, apiKey: apiKey.trim() })
      setApiKey('')
      setKeyMsg('Saved')
    } catch (err) {
      setKeyMsg(String(err))
    } finally {
      setKeyBusy(false)
    }
  }

  async function clearKey() {
    setKeyBusy(true)
    setKeyMsg(null)
    try {
      await ipcInvoke('settings:clearApiKey', { profileId: profile.id })
      setKeyMsg('Cleared')
    } catch (err) {
      setKeyMsg(String(err))
    } finally {
      setKeyBusy(false)
    }
  }

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" checked={active} onChange={onActive} disabled={busy} />
          <span className="font-medium">{profile.name}</span>
          <span className="text-xs text-zinc-500">({profile.id})</span>
        </label>
        <button
          onClick={onDelete}
          disabled={busy}
          className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
        >
          Delete
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <Field label="Base URL" value={profile.baseUrl} disabled={busy} onChange={(v) => onChange({ baseUrl: v })} />
        <Field label="Model" value={profile.model} disabled={busy} onChange={(v) => onChange({ model: v })} />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={canSaveKey ? 'API key…' : 'Keychain unavailable'}
          spellCheck={false}
          disabled={!canSaveKey}
          className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs placeholder-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={saveKey}
          disabled={keyBusy || !apiKey.trim() || !canSaveKey}
          className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
        >
          Save key
        </button>
        <button
          onClick={clearKey}
          disabled={keyBusy || !canSaveKey}
          className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
        >
          Clear
        </button>
      </div>
      {keyMsg && <div className="mt-1 text-xs text-zinc-400">{keyMsg}</div>}
    </div>
  )
}

function Field({ label, value, disabled, onChange }: {
  label: string
  value: string
  disabled?: boolean
  onChange: (v: string) => void
}) {
  return (
    <label className="block">
      <span className="text-zinc-500">{label}</span>
      <input
        type="text"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="mt-0.5 w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-zinc-200 focus:border-zinc-600 focus:outline-none"
      />
    </label>
  )
}
