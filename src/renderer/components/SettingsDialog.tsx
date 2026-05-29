import { useEffect, useState } from 'react'
import {
  defaultAiProfileSuggestions,
  type AiProfile,
  type NetworkGroup,
  type RetryPolicy,
  type Settings,
} from '@shared/settings'
import { ipcInvoke } from '@renderer/ipc/client'
import { useRuntimeStore } from '@renderer/store/runtime'
import { Dialog } from '@renderer/components/Dialog'

type Props = { onClose: () => void }

/**
 * Settings dialog covering the user-editable surfaces in v1:
 *   - Behavior (autostart, concurrency)
 *   - AI profiles (add/select/delete, set/clear API key)
 *
 * Library directory and log retention are intentionally left out of the UI
 * for v1 — defaults are sensible; advanced users can edit
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
      <Dialog title="Settings" onClose={onClose} size="xl">
        <p className="text-sm text-zinc-400">Loading…</p>
      </Dialog>
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

  async function updatePolicy(group: NetworkGroup, patch: Partial<RetryPolicy>) {
    if (!settings) return
    await updateSetting('network', {
      ...settings.network,
      [group]: { ...settings.network[group], ...patch },
    })
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
    <Dialog title="Settings" onClose={onClose} size="xl">
      <div className="space-y-8">
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
            <Toggle
              label="Check for tool updates on startup"
              description="Look for newer yt-dlp, ffmpeg, and Deno releases once when TapeBox launches."
              checked={settings.autoCheckBinaryUpdates}
              disabled={busy}
              onChange={(v) => updateSetting('autoCheckBinaryUpdates', v)}
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

          <Section title="Network" hint="Timeouts and retries for internet actions. The defaults are sensible.">
            <details className="rounded border border-zinc-800 p-3">
              <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-200">
                Advanced timeout &amp; retry settings
              </summary>
              <div className="mt-4 space-y-4">
                {NETWORK_GROUPS.map((group) => (
                  <PolicyEditor
                    key={group}
                    group={group}
                    policy={settings.network[group]}
                    busy={busy}
                    onChange={(patch) => updatePolicy(group, patch)}
                  />
                ))}
              </div>
            </details>
          </Section>

          {error && (
            <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
          )}
      </div>
    </Dialog>
  )
}

function presetButtons(existing: AiProfile[]): AiProfile[] {
  const existingIds = new Set(existing.map((p) => p.id))
  return defaultAiProfileSuggestions().filter((p) => !existingIds.has(p.id))
}

const NETWORK_GROUPS: NetworkGroup[] = ['metadata', 'download', 'ai']
const GROUP_LABEL: Record<NetworkGroup, string> = {
  metadata: 'Metadata & probes',
  download: 'Downloads',
  ai: 'AI',
}

function PolicyEditor({ group, policy, busy, onChange }: {
  group: NetworkGroup
  policy: RetryPolicy
  busy: boolean
  onChange: (patch: Partial<RetryPolicy>) => void
}) {
  return (
    <div className="space-y-3 rounded border border-zinc-800 p-3">
      <div className="text-sm font-medium">{GROUP_LABEL[group]}</div>
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Timeout (s)"
          value={Math.round(policy.timeoutMs / 1000)}
          min={1}
          max={600}
          disabled={busy}
          onChange={(s) => onChange({ timeoutMs: s * 1000 })}
        />
        <NumberField
          label="Jitter (%)"
          value={Math.round(policy.jitterRatio * 100)}
          min={0}
          max={100}
          disabled={busy}
          onChange={(p) => onChange({ jitterRatio: p / 100 })}
        />
      </div>
      <IntervalsField intervals={policy.intervals} disabled={busy} onChange={(arr) => onChange({ intervals: arr })} />
    </div>
  )
}

function IntervalsField({ intervals, disabled, onChange }: {
  intervals: number[]
  disabled?: boolean
  onChange: (intervalsMs: number[]) => void
}) {
  const [text, setText] = useState(() => intervals.map((ms) => ms / 1000).join(', '))

  function commit() {
    const arr = text
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .map((t) => Math.round(parseFloat(t) * 1000))
      .filter((ms) => Number.isFinite(ms) && ms >= 0)
    onChange(arr)
    setText(arr.map((ms) => ms / 1000).join(', '))
  }

  return (
    <label className="block">
      <span className="text-xs text-zinc-500">
        Retry intervals in seconds — {intervals.length} {intervals.length === 1 ? 'retry' : 'retries'}
      </span>
      <input
        type="text"
        value={text}
        disabled={disabled}
        spellCheck={false}
        placeholder="1, 3, 8"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        className="mt-0.5 w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm focus:border-zinc-600 focus:outline-hidden disabled:opacity-50"
      />
    </label>
  )
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
        className="w-20 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm focus:border-zinc-600 focus:outline-hidden"
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
          className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs placeholder-zinc-600 focus:border-zinc-600 focus:outline-hidden disabled:opacity-50"
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
        className="mt-0.5 w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-zinc-200 focus:border-zinc-600 focus:outline-hidden"
      />
    </label>
  )
}
