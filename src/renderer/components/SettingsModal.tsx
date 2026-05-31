import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import type { AiSettings, NetworkGroup, RetryPolicy, Settings, SiteProfile } from '@shared/settings'
import { DEFAULT_SLUG_PROMPT } from '@shared/settings'
import { ipcInvoke } from '@renderer/ipc/client'
import { useRuntimeStore } from '@renderer/store/runtime'
import { useSettingsStore } from '@renderer/store/settings'
import { Modal } from '@renderer/components/Modal'
import { ConfirmModal } from '@renderer/components/ConfirmModal'
import {
  Button,
  Field,
  INPUT_CLASS,
  IntervalsField,
  NumberField,
  TextField,
  Toggle,
} from '@renderer/components/ui'

type Props = { onClose: () => void }
type Tab = 'general' | 'ai' | 'network' | 'ytdlp'

/**
 * Settings is a draft form: every edit lives in local state, the footer Save
 * button persists everything in one IPC roundtrip, and closing with unsaved
 * changes prompts a shared ConfirmModal to discard. The AI tab folds the API
 * key into the same save (no separate "Save key" button).
 *
 * Library directory and log retention are intentionally left out of the UI for
 * v1 — defaults are sensible; advanced users can edit ~/.tapebox/config.json
 * directly.
 */
export function SettingsModal({ onClose }: Props) {
  const runtime = useRuntimeStore((s) => s.info)
  const [tab, setTab] = useState<Tab>('general')
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

  function patchPrompts(patch: Partial<Settings['prompts']>) {
    if (!draft) return
    patchDraft({ prompts: { ...draft.prompts, ...patch } })
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
      const updated = await ipcInvoke('settings:update', pickEditable(draft))
      useSettingsStore.getState().setSettings(updated)
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
      <Modal title="Settings" onClose={onClose} size="2xl">
        <p className="text-sm text-zinc-300">Loading…</p>
      </Modal>
    )
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={requestClose} disabled={busy}>
        Cancel
      </Button>
      <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
        {busy ? 'Saving…' : 'Save'}
      </Button>
    </>
  )

  return (
    <>
      <Modal
        title="Settings"
        onClose={requestClose}
        size="2xl"
        footer={footer}
        closeDisabled={busy}
      >
        <div className="flex gap-6">
          <TabBar tab={tab} onTab={setTab} />
          <div className="min-w-0 flex-1">
            {tab === 'general' && (
              <GeneralTab draft={draft} busy={busy} onPatch={patchDraft} />
            )}
            {tab === 'ai' && (
              <AiTab
                ai={draft.ai}
                prompts={draft.prompts}
                onPromptsPatch={patchPrompts}
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
              <NetworkTab draft={draft} busy={busy} onPatch={patchPolicy} />
            )}
            {tab === 'ytdlp' && (
              <YtdlpTab draft={draft} busy={busy} onPatch={patchDraft} />
            )}
          </div>
        </div>

        {error && (
          <p className="mt-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
        )}
      </Modal>

      {confirmDiscard && (
        <ConfirmModal
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
    autoplay: s.autoplay,
    playSound: s.playSound,
    trashOnRemove: s.trashOnRemove,
    confirmRemove: s.confirmRemove,
    autoCheckBinaryUpdates: s.autoCheckBinaryUpdates,
    externalPlayer: s.externalPlayer,
    ai: s.ai,
    prompts: s.prompts,
    network: s.network,
    ytdlpArgs: s.ytdlpArgs,
    siteProfiles: s.siteProfiles,
  }
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI' },
  { id: 'network', label: 'Network' },
  { id: 'ytdlp', label: 'yt-dlp' },
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
                  : 'text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100')
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

// ── General tab ─────────────────────────────────────────────────────────────

function GeneralTab({
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
        label="Autoplay"
        description="Start playback automatically when a downloaded tape is opened."
        checked={draft.autoplay}
        disabled={busy}
        onChange={(v) => onPatch({ autoplay: v })}
      />
      <Toggle
        label="Play sound"
        description="Play video audio. When off, every video is muted and the volume control can't unmute it."
        checked={draft.playSound}
        disabled={busy}
        onChange={(v) => onPatch({ playSound: v })}
      />
      <Toggle
        label="Confirm before removing"
        description="Ask for confirmation before a tape is removed."
        checked={draft.confirmRemove}
        disabled={busy}
        onChange={(v) => onPatch({ confirmRemove: v })}
      />
      <Toggle
        label="Move removed tapes to Trash"
        description="Removed tapes go to the OS Trash (recoverable). Off = deleted permanently."
        checked={draft.trashOnRemove}
        disabled={busy}
        onChange={(v) => onPatch({ trashOnRemove: v })}
      />
      <Toggle
        label="Check for tool updates on startup"
        description="Look for newer yt-dlp, ffmpeg, and Deno releases once when TapeBox launches."
        checked={draft.autoCheckBinaryUpdates}
        disabled={busy}
        onChange={(v) => onPatch({ autoCheckBinaryUpdates: v })}
      />
      <TextField
        label="External player"
        value={draft.externalPlayer}
        placeholder="Blank = system default (e.g. VLC)"
        disabled={busy}
        onChange={(v) => onPatch({ externalPlayer: v })}
      />
    </div>
  )
}

// ── AI tab ──────────────────────────────────────────────────────────────────

function AiTab({
  ai,
  prompts,
  onPromptsPatch,
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
  prompts: Settings['prompts']
  onPromptsPatch: (p: Partial<Settings['prompts']>) => void
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
      <p className="text-sm text-zinc-300">
        Used to suggest a file slug from each tape&apos;s title. TapeBox currently supports OpenAI-compatible providers only.
      </p>

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
        <div className="text-xs font-medium text-zinc-300">API key</div>
        {keyIsSet && <div className="mt-0.5 text-xs text-zinc-300">Key is set</div>}
        <div className="mt-1 flex items-center gap-2">
          <input
            type="password"
            value={apiKeyDraft}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={keyIsSet ? '••••••••' : 'sk-…'}
            spellCheck={false}
            disabled={busy || !encryptionAvailable}
            className={`flex-1 ${INPUT_CLASS}`}
          />
          {keyIsSet && (
            <Button variant="danger" onClick={onClearKey} disabled={busy}>
              Clear
            </Button>
          )}
        </div>
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

      <div className="border-t border-zinc-700 pt-4">
        <Field label="Slug prompt">
          <textarea
            value={prompts.slug}
            rows={7}
            spellCheck={false}
            disabled={busy}
            onChange={(e) => onPromptsPatch({ slug: e.target.value })}
            className={`w-full resize-y font-mono ${INPUT_CLASS}`}
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <p className="text-xs text-zinc-300">
              Tokens: <code>{'{title}'}</code>, <code>{'{uploader}'}</code>.
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || prompts.slug === DEFAULT_SLUG_PROMPT}
              onClick={() => onPromptsPatch({ slug: DEFAULT_SLUG_PROMPT })}
            >
              Restore default
            </Button>
          </div>
        </Field>
      </div>
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
    <div className="space-y-3 rounded border border-zinc-700 p-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-zinc-300">{hint}</div>
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
      <IntervalsField
        label="Retry intervals in seconds — last reused if retries > intervals"
        intervals={policy.intervals}
        disabled={busy}
        onChange={(arr) => onChange({ intervals: arr })}
      />
    </div>
  )
}

// ── yt-dlp tab ──────────────────────────────────────────────────────────────

function YtdlpTab({
  draft,
  busy,
  onPatch,
}: {
  draft: Settings
  busy: boolean
  onPatch: (p: Partial<Settings>) => void
}) {
  function patchProfile(id: string, patch: Partial<SiteProfile>) {
    onPatch({ siteProfiles: draft.siteProfiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) })
  }
  function addProfile() {
    const profile: SiteProfile = { id: nanoid(8), name: '', urlPattern: '', isRegex: false, args: '', comment: '' }
    onPatch({ siteProfiles: [...draft.siteProfiles, profile] })
  }
  function removeProfile(id: string) {
    onPatch({ siteProfiles: draft.siteProfiles.filter((p) => p.id !== id) })
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-300">
        Extra yt-dlp arguments. Global args apply to every download, probe, and scan; a site profile&apos;s
        args are added when its pattern matches the URL. TapeBox&apos;s own flags (output, info json) always win.
      </p>

      <div>
        <div className="text-xs font-medium text-zinc-300">Global arguments</div>
        <textarea
          value={draft.ytdlpArgs}
          onChange={(e) => onPatch({ ytdlpArgs: e.target.value })}
          placeholder={'--add-header "Accept-Language: ja"'}
          spellCheck={false}
          disabled={busy}
          rows={2}
          className={`mt-1 w-full font-mono ${INPUT_CLASS}`}
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium text-zinc-300">Site profiles</div>
          <Button variant="secondary" size="sm" onClick={addProfile} disabled={busy}>
            Add profile
          </Button>
        </div>

        {draft.siteProfiles.length === 0 && (
          <p className="text-xs text-zinc-400">No profiles. Add one to apply args to a specific site.</p>
        )}

        {draft.siteProfiles.map((p) => (
          <div key={p.id} className="space-y-2 rounded border border-zinc-700 p-3">
            <div className="flex items-center gap-2">
              <input
                value={p.name}
                onChange={(e) => patchProfile(p.id, { name: e.target.value })}
                placeholder="Name"
                spellCheck={false}
                disabled={busy}
                className={`flex-1 ${INPUT_CLASS}`}
              />
              <Button variant="danger" size="sm" onClick={() => removeProfile(p.id)} disabled={busy}>
                Remove
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={p.urlPattern}
                onChange={(e) => patchProfile(p.id, { urlPattern: e.target.value })}
                placeholder="example.com (or a regex)"
                spellCheck={false}
                disabled={busy}
                className={`flex-1 ${INPUT_CLASS}`}
              />
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={p.isRegex}
                  onChange={(e) => patchProfile(p.id, { isRegex: e.target.checked })}
                  disabled={busy}
                />
                Regex
              </label>
            </div>
            <input
              value={p.args}
              onChange={(e) => patchProfile(p.id, { args: e.target.value })}
              placeholder={'--add-header "Accept-Language: ja" -f bestvideo+bestaudio'}
              spellCheck={false}
              disabled={busy}
              className={`w-full font-mono ${INPUT_CLASS}`}
            />
            <input
              value={p.comment}
              onChange={(e) => patchProfile(p.id, { comment: e.target.value })}
              placeholder="Comment (optional)"
              spellCheck={false}
              disabled={busy}
              className={`w-full ${INPUT_CLASS}`}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
