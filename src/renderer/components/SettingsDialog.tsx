import { useEffect, useState } from 'react'
import type { AiSettings, NetworkGroup, RetryPolicy, Settings } from '@shared/settings'
import { ipcInvoke } from '@renderer/ipc/client'
import { useRuntimeStore } from '@renderer/store/runtime'
import { Dialog } from '@renderer/components/Dialog'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'

type Props = { onClose: () => void }
type Tab = 'behavior' | 'ai' | 'network'

/**
 * Settings is a draft form: every edit lives in local state, the footer Save
 * button persists everything in one IPC roundtrip, and closing with unsaved
 * changes prompts a shared ConfirmDialog to discard. The AI tab folds the API
 * key into the same save (no separate "Save key" button).
 *
 * Library directory and log retention are intentionally left out of the UI for
 * v1 — defaults are sensible; advanced users can edit ~/.tapebox/config.json
 * directly.
 */
export function SettingsDialog({ onClose }: Props) {
  const runtime = useRuntimeStore((s) => s.info)
  const [tab, setTab] = useState<Tab>('behavior')
  const [original, setOriginal] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [hadApiKey, setHadApiKey] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [wantsClearKey, setWantsClearKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  useEffect(() => {
    void Promise.all([
      ipcInvoke('settings:get'),
      ipcInvoke('settings:hasApiKey').catch(() => false),
    ]).then(([s, has]) => {
      setOriginal(s)
      setDraft(s)
      setHadApiKey(has)
    })
  }, [])

  function patchDraft(patch: Partial<Settings>) {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  function patchAi(patch: Partial<AiSettings>) {
    if (!draft) return
    patchDraft({ ai: { ...draft.ai, ...patch } })
  }

  function patchPolicy(group: NetworkGroup, patch: Partial<RetryPolicy>) {
    if (!draft) return
    patchDraft({
      network: {
        ...draft.network,
        [group]: { ...draft.network[group], ...patch },
      },
    })
  }

  const settingsDirty =
    !!original && !!draft && JSON.stringify(pickEditable(original)) !== JSON.stringify(pickEditable(draft))
  const apiKeyDirty = apiKeyDraft.length > 0 || wantsClearKey
  const dirty = settingsDirty || apiKeyDirty

  async function save() {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      await ipcInvoke('settings:update', pickEditable(draft))
      if (apiKeyDraft.length > 0) {
        await ipcInvoke('settings:setApiKey', { apiKey: apiKeyDraft })
      } else if (wantsClearKey) {
        await ipcInvoke('settings:clearApiKey')
      }
      onClose()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  function requestClose() {
    if (busy) return
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }

  if (!draft) {
    return (
      <Dialog title="Settings" onClose={onClose} size="xl">
        <p className="text-sm text-zinc-400">Loading…</p>
      </Dialog>
    )
  }

  const footer = (
    <>
      <button
        onClick={requestClose}
        disabled={busy}
        className="rounded px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        onClick={() => void save()}
        disabled={busy || !dirty}
        className="rounded bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-950 transition disabled:bg-zinc-700 disabled:text-zinc-400"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
    </>
  )

  return (
    <>
      <Dialog
        title="Settings"
        onClose={requestClose}
        size="xl"
        footer={footer}
        closeDisabled={busy}
      >
        <div className="flex gap-6">
          <TabBar tab={tab} onTab={setTab} />
          <div className="min-w-0 flex-1">
            {tab === 'behavior' && (
              <BehaviorTab
                draft={draft}
                busy={busy}
                onPatch={patchDraft}
              />
            )}
            {tab === 'ai' && (
              <AiTab
                ai={draft.ai}
                busy={busy}
                hadKey={hadApiKey}
                apiKeyDraft={apiKeyDraft}
                wantsClearKey={wantsClearKey}
                encryptionAvailable={runtime?.encryptionAvailable ?? false}
                onAiPatch={patchAi}
                onApiKeyChange={(v) => {
                  setApiKeyDraft(v)
                  if (v.length > 0) setWantsClearKey(false)
                }}
                onClearKey={() => {
                  setApiKeyDraft('')
                  setWantsClearKey(true)
                }}
              />
            )}
            {tab === 'network' && (
              <NetworkTab
                draft={draft}
                busy={busy}
                onPatch={patchPolicy}
              />
            )}
          </div>
        </div>

        {error && (
          <p className="mt-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
        )}
      </Dialog>

      {confirmDiscard && (
        <ConfirmDialog
          title="Unsaved changes"
          message="Discard your changes?"
          cancelLabel="Keep editing"
          confirmLabel="Discard"
          danger
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false)
            onClose()
          }}
        />
      )}
    </>
  )
}

function pickEditable(s: Settings) {
  return {
    autoStartDownloads: s.autoStartDownloads,
    maxConcurrentDownloads: s.maxConcurrentDownloads,
    autoCheckBinaryUpdates: s.autoCheckBinaryUpdates,
    ai: s.ai,
    network: s.network,
  }
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'behavior', label: 'Behavior' },
  { id: 'ai', label: 'AI' },
  { id: 'network', label: 'Network' },
]

function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <nav className="w-32 shrink-0">
      <ul className="space-y-0.5">
        {TABS.map((t) => (
          <li key={t.id}>
            <button
              onClick={() => onTab(t.id)}
              className={
                'w-full rounded px-3 py-1.5 text-left text-sm transition ' +
                (tab === t.id
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100')
              }
            >
              {t.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

// ── Behavior tab ────────────────────────────────────────────────────────────

function BehaviorTab({
  draft,
  busy,
  onPatch,
}: {
  draft: Settings
  busy: boolean
  onPatch: (p: Partial<Settings>) => void
}) {
  return (
    <div className="space-y-4">
      <Toggle
        label="Autostart downloads"
        description="Newly added items start downloading immediately. Off = added as paused."
        checked={draft.autoStartDownloads}
        disabled={busy}
        onChange={(v) => onPatch({ autoStartDownloads: v })}
      />
      <NumberField
        label="Max concurrent downloads"
        value={draft.maxConcurrentDownloads}
        min={1}
        max={8}
        disabled={busy}
        onChange={(v) => onPatch({ maxConcurrentDownloads: v })}
      />
      <Toggle
        label="Check for tool updates on startup"
        description="Look for newer yt-dlp, ffmpeg, and Deno releases once when TapeBox launches."
        checked={draft.autoCheckBinaryUpdates}
        disabled={busy}
        onChange={(v) => onPatch({ autoCheckBinaryUpdates: v })}
      />
    </div>
  )
}

// ── AI tab ──────────────────────────────────────────────────────────────────

function AiTab({
  ai,
  busy,
  hadKey,
  apiKeyDraft,
  wantsClearKey,
  encryptionAvailable,
  onAiPatch,
  onApiKeyChange,
  onClearKey,
}: {
  ai: AiSettings
  busy: boolean
  hadKey: boolean
  apiKeyDraft: string
  wantsClearKey: boolean
  encryptionAvailable: boolean
  onAiPatch: (p: Partial<AiSettings>) => void
  onApiKeyChange: (v: string) => void
  onClearKey: () => void
}) {
  const keyIsSet = hadKey && !wantsClearKey && apiKeyDraft.length === 0
  const willClear = wantsClearKey && apiKeyDraft.length === 0

  return (
    <div className="space-y-4">
      {!encryptionAvailable && (
        <div className="rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
          The OS keychain is unavailable on this system, so the API key can't be saved securely.
        </div>
      )}

      <TextField
        label="Base URL"
        value={ai.baseUrl}
        placeholder="https://api.openai.com/v1"
        disabled={busy}
        onChange={(v) => onAiPatch({ baseUrl: v })}
      />

      <div>
        <label className="block">
          <span className="text-xs font-medium text-zinc-400">API key</span>
          <input
            type="password"
            value={apiKeyDraft}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={keyIsSet ? '••••••••' : 'sk-…'}
            spellCheck={false}
            disabled={busy || !encryptionAvailable}
            className="mt-1 w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm placeholder-zinc-600 focus:border-zinc-600 focus:outline-hidden disabled:opacity-50"
          />
        </label>
        {keyIsSet && (
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-zinc-400">Key is set</span>
            <button
              onClick={onClearKey}
              disabled={busy}
              className="text-red-400 hover:text-red-300 disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        )}
        {willClear && (
          <p className="mt-1 text-xs text-amber-300">Key will be cleared on save.</p>
        )}
      </div>

      <TextField
        label="Model"
        value={ai.model}
        placeholder="gpt-5.4-mini"
        disabled={busy}
        onChange={(v) => onAiPatch({ model: v })}
      />
    </div>
  )
}

// ── Network tab ─────────────────────────────────────────────────────────────

const NETWORK_GROUPS: NetworkGroup[] = ['lookups', 'download', 'ai']
const GROUP_LABEL: Record<NetworkGroup, string> = {
  lookups: 'Lookups',
  download: 'Downloads',
  ai: 'AI',
}
const GROUP_HINT: Record<NetworkGroup, string> = {
  lookups: 'yt-dlp probe / playlist enumeration, GitHub & evermeet version checks.',
  download: 'Binary downloads (yt-dlp, ffmpeg, Deno) and yt-dlp media downloads.',
  ai: 'AI provider calls (slug generation).',
}

function NetworkTab({
  draft,
  busy,
  onPatch,
}: {
  draft: Settings
  busy: boolean
  onPatch: (group: NetworkGroup, patch: Partial<RetryPolicy>) => void
}) {
  return (
    <div className="space-y-4">
      {NETWORK_GROUPS.map((group) => (
        <PolicyEditor
          key={group}
          label={GROUP_LABEL[group]}
          hint={GROUP_HINT[group]}
          policy={draft.network[group]}
          busy={busy}
          onChange={(patch) => onPatch(group, patch)}
        />
      ))}
    </div>
  )
}

function PolicyEditor({
  label,
  hint,
  policy,
  busy,
  onChange,
}: {
  label: string
  hint: string
  policy: RetryPolicy
  busy: boolean
  onChange: (patch: Partial<RetryPolicy>) => void
}) {
  return (
    <div className="space-y-3 rounded border border-zinc-800 p-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-zinc-400">{hint}</div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <NumberField
          label="Timeout (s)"
          value={Math.round(policy.timeoutMs / 1000)}
          min={1}
          max={600}
          disabled={busy}
          onChange={(s) => onChange({ timeoutMs: s * 1000 })}
        />
        <NumberField
          label="Retries"
          value={policy.retries}
          min={0}
          max={20}
          disabled={busy}
          onChange={(r) => onChange({ retries: r })}
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

function IntervalsField({
  intervals,
  disabled,
  onChange,
}: {
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
      <span className="text-xs text-zinc-400">
        Retry intervals in seconds — last reused if retries &gt; intervals
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
        className="mt-1 w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm focus:border-zinc-600 focus:outline-hidden disabled:opacity-50"
      />
    </label>
  )
}

// ── Form primitives ────────────────────────────────────────────────────────

function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
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
        {description && <div className="text-xs text-zinc-400">{description}</div>}
      </div>
    </label>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  disabled?: boolean
  onChange: (v: number) => void
}) {
  return (
    <label className="block">
      <span className="text-xs text-zinc-400">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Math.max(min, Math.min(max, parseInt(e.target.value || '0', 10))))}
        className="mt-1 w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm focus:border-zinc-600 focus:outline-hidden disabled:opacity-50"
      />
    </label>
  )
}

function TextField({
  label,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  disabled?: boolean
  onChange: (v: string) => void
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm placeholder-zinc-600 focus:border-zinc-600 focus:outline-hidden disabled:opacity-50"
      />
    </label>
  )
}
