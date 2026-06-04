import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import type { AiSettings, Settings, SiteProfile } from '@shared/settings'
import { DEFAULT_SLUG_PROMPT } from '@shared/settings'
import { ipcInvoke } from '@renderer/ipc/client'
import { useSettingsStore } from '@renderer/store/settings'
import { Modal } from '@renderer/components/Modal'
import { ConfirmModal } from '@renderer/components/ConfirmModal'
import {
  AutoTextarea,
  Button,
  Field,
  INPUT_CLASS,
  NumberField,
  TextField,
  Toggle,
} from '@renderer/components/ui'

type Props = { onClose: () => void }
type Tab = 'general' | 'ai' | 'ytdlp'

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
    metadataLanguage: s.metadataLanguage,
    ytdlpArgs: s.ytdlpArgs,
    siteProfiles: s.siteProfiles,
  }
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI' },
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
        label="Check for tool updates on startup"
        description="Look for newer yt-dlp, ffmpeg, and Deno releases once when TapeBox launches."
        checked={draft.autoCheckBinaryUpdates}
        disabled={busy}
        onChange={(v) => onPatch({ autoCheckBinaryUpdates: v })}
      />
      <Toggle
        label="Autostart downloads"
        description="Newly added tapes start downloading immediately. Off = added as paused."
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
      <TextField
        label="External player"
        value={draft.externalPlayer}
        placeholder="Blank = system default (e.g. VLC)"
        disabled={busy}
        onChange={(v) => onPatch({ externalPlayer: v })}
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
            disabled={busy}
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
              Tokens: <code>{'{title}'}</code>, <code>{'{uploader}'}</code>,{' '}
              <code>{'{description}'}</code>.
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
      <p className="text-xs text-zinc-400">
        TapeBox&apos;s own flags (output, info json) always win on conflict.
      </p>

      <div>
        <TextField
          label="Preferred metadata language"
          value={draft.metadataLanguage}
          placeholder="e.g. ja, en, pt-BR — blank = source default"
          disabled={busy}
          onChange={(v) => onPatch({ metadataLanguage: v })}
        />
        <p className="mt-1 text-xs text-zinc-400">
          Requests titles in this language where the site offers them (sets a
          general <code className="mx-1">Accept-Language</code> header). An
          explicit site profile or global argument below overrides it.
        </p>
      </div>

      <div>
        <div className="text-xs font-medium text-zinc-300">Global arguments</div>
        <div className="mt-1">
          <AutoTextarea
            value={draft.ytdlpArgs}
            onChange={(v) => onPatch({ ytdlpArgs: v })}
            placeholder={'--add-header "Accept-Language: ja"\n--sleep-requests "1"'}
            disabled={busy}
            mono
          />
        </div>
        <p className="mt-1 text-xs text-zinc-400">
          One flag per line (or space-separated). Quote any value that contains
          spaces. Backslashes are literal — not line-continuations — so Windows
          paths work as written.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium text-zinc-300">Site profiles</div>
          <Button variant="secondary" size="sm" onClick={addProfile} disabled={busy}>
            Add profile
          </Button>
        </div>

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
            <AutoTextarea
              value={p.args}
              onChange={(v) => patchProfile(p.id, { args: v })}
              placeholder={'--add-header "Accept-Language: ja" -f bestvideo+bestaudio'}
              disabled={busy}
              mono
            />
            <AutoTextarea
              value={p.comment}
              onChange={(v) => patchProfile(p.id, { comment: v })}
              placeholder="Comment (optional)"
              disabled={busy}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
