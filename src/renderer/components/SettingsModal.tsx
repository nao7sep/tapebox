import { useEffect, useState, useRef, type KeyboardEvent } from 'react'
import { nanoid } from 'nanoid'
import type { AiSettings, Settings, SiteProfile } from '@shared/settings'
import { DEFAULT_SLUG_PROMPT } from '@shared/settings'
import { ipcInvoke } from '@renderer/ipc/client'
import { useSettingsStore } from '@renderer/store/settings'
import { useTapesStore } from '@renderer/store/tapes'
import { Modal } from '@renderer/components/Modal'
import { ConfirmModal } from '@renderer/components/ConfirmModal'
import {
  AutoTextarea,
  Button,
  Field,
  INPUT_CLASS,
  NumberField,
  Spinner,
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
 * The library folder is a picker-backed field on the General tab, grouped with the
 * download settings. Leaving it blank uses the default folder (shown as the
 * field's placeholder); a set value points the library at a custom folder. Changing
 * it moves every existing tape's files to the new folder as part of Save (main does
 * the move, then commits the setting), so a confirm prompts first; the move is
 * refused while downloads are running.
 */
export function SettingsModal({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>('general')
  const [original, setOriginal] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [hadApiKey, setHadApiKey] = useState(false)
  const [defaultLibraryDir, setDefaultLibraryDir] = useState('')
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [wantsClearKey, setWantsClearKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [confirmMove, setConfirmMove] = useState<{ count: number } | null>(null)

  useEffect(() => {
    void Promise.all([
      ipcInvoke('settings:get'),
      // On failure (main logs it) degrade to "no key set" rather than block the
      // form — a value fallback, not an ignored error.
      ipcInvoke('settings:hasApiKey').catch(() => false),
      // The default library folder, shown as the empty-field placeholder. On
      // failure just fall back to no placeholder rather than block the form.
      ipcInvoke('settings:defaultLibraryDir').catch(() => ''),
    ]).then(([s, has, defaultLibDir]) => {
      setOriginal(s)
      setDraft(s)
      setHadApiKey(has)
      setDefaultLibraryDir(defaultLibDir)
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

  // How many existing tapes have files on disk that a library move would relocate.
  // Used only to decide whether to prompt before Save and to phrase the prompt;
  // main does the actual move and is the source of truth for what's moved.
  function tapesOnDiskCount(): number {
    return useTapesStore.getState().tapes.filter((t) => t.filename).length
  }

  // The library folder effectively changed when its resolved value differs — blank
  // means the default folder, so blank↔default and any custom↔custom edit count,
  // while a whitespace-only tweak that still resolves to the same folder does not.
  function libraryDirChanged(): boolean {
    if (!original || !draft) return false
    const effective = (v: string) => v.trim() || defaultLibraryDir
    return effective(original.libraryDir) !== effective(draft.libraryDir)
  }

  // Save splits into a request (which may prompt) and the commit. A library move is
  // a real, user-visible relocation of their files, so it gets a confirm first when
  // there are tapes to move; everything else saves straight through.
  function requestSave() {
    if (!draft) return
    const count = tapesOnDiskCount()
    if (libraryDirChanged() && count > 0) {
      setConfirmMove({ count })
      return
    }
    void save()
  }

  async function save() {
    if (!draft) return
    setConfirmMove(null)
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
        <p className="flex items-center gap-2 text-sm text-zinc-300">
          <Spinner /> Loading…
        </p>
      </Modal>
    )
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={requestClose} disabled={busy}>
        Cancel
      </Button>
      <Button variant="primary" onClick={requestSave} disabled={!dirty} loading={busy}>
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
              <GeneralTab
                draft={draft}
                busy={busy}
                onPatch={patchDraft}
                defaultLibraryDir={defaultLibraryDir}
              />
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

      {confirmMove && (
        <ConfirmModal
          title="Move library?"
          message={
            `This will move ${confirmMove.count} ${confirmMove.count === 1 ? 'tape' : 'tapes'} to the new folder. ` +
            `The move must finish completely before the new folder is saved.`
          }
          cancelLabel="Cancel"
          confirmLabel="Move"
          onCancel={() => setConfirmMove(null)}
          onConfirm={() => void save()}
        />
      )}
    </>
  )
}

function pickEditable(s: Settings) {
  return {
    libraryDir: s.libraryDir,
    autoStartDownloads: s.autoStartDownloads,
    maxConcurrentDownloads: s.maxConcurrentDownloads,
    autoplay: s.autoplay,
    playSound: s.playSound,
    keepAwakeWhilePlaying: s.keepAwakeWhilePlaying,
    trashOnRemove: s.trashOnRemove,
    confirmRemove: s.confirmRemove,
    externalPlayer: s.externalPlayer,
    defaultExportDir: s.defaultExportDir,
    deleteAfterExport: s.deleteAfterExport,
    uiFontFamily: s.uiFontFamily,
    ai: s.ai,
    prompts: s.prompts,
    ytdlpArgs: s.ytdlpArgs,
    siteProfiles: s.siteProfiles,
  }
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI' },
  { id: 'ytdlp', label: 'yt-dlp' },
]

// A vertical tablist: one tab stop (the active tab via roving tabindex), Up/Down
// move and activate immediately (switching a settings panel is cheap), Home/End
// jump to the ends, and the arrows stop at the ends rather than wrapping.
function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const listRef = useRef<HTMLDivElement>(null)
  const activeIndex = TABS.findIndex((t) => t.id === tab)

  const focusTab = (index: number) => {
    ;(
      listRef.current?.querySelector(
        `[data-tab-index="${index}"]`,
      ) as HTMLElement | null
    )?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let target: number | null = null
    if (e.key === 'ArrowDown') target = Math.min(activeIndex + 1, TABS.length - 1)
    else if (e.key === 'ArrowUp') target = Math.max(activeIndex - 1, 0)
    else if (e.key === 'Home') target = 0
    else if (e.key === 'End') target = TABS.length - 1
    else return
    e.preventDefault()
    onTab(TABS[target].id)
    focusTab(target)
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-orientation="vertical"
      aria-label="Settings sections"
      onKeyDown={onKeyDown}
      className="w-32 shrink-0 space-y-0.5"
    >
      {TABS.map((t, i) => {
        const selected = tab === t.id
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-tab-index={i}
            onClick={() => onTab(t.id)}
            className={
              'block w-full rounded px-3 py-1.5 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-400 ' +
              (selected
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100')
            }
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

// ── General tab ─────────────────────────────────────────────────────────────

function GeneralTab({
  draft,
  busy,
  onPatch,
  defaultLibraryDir,
}: {
  draft: Settings
  busy: boolean
  onPatch: (p: Partial<Settings>) => void
  defaultLibraryDir: string
}) {
  async function chooseExportDir() {
    const dir = await ipcInvoke('dialog:pickDirectory', { title: 'Choose default export folder' })
    if (dir) onPatch({ defaultExportDir: dir })
  }
  async function chooseLibraryDir() {
    const dir = await ipcInvoke('dialog:pickDirectory', { title: 'Choose library folder' })
    if (dir) onPatch({ libraryDir: dir })
  }
  return (
    <div className="space-y-4">
      <div>
        <TextField
          label="UI font"
          value={draft.uiFontFamily}
          placeholder="Blank = default system font"
          disabled={busy}
          onChange={(v) => onPatch({ uiFontFamily: v })}
        />
        <p className="mt-1 text-xs text-zinc-400">
          Comma-separated font families; the first one your system has is used. Blank uses the built-in default.
        </p>
      </div>
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
      <div>
        <div className="text-xs font-medium text-zinc-300">Library folder</div>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="text"
            value={draft.libraryDir}
            onChange={(e) => onPatch({ libraryDir: e.target.value })}
            placeholder={defaultLibraryDir}
            spellCheck={false}
            disabled={busy}
            className={`flex-1 ${INPUT_CLASS}`}
          />
          <Button variant="secondary" size="sm" onClick={() => void chooseLibraryDir()} disabled={busy}>
            Choose…
          </Button>
        </div>
        <p className="mt-1 text-xs text-zinc-400">
          Where tapes are saved. Changing this moves your existing tapes to the new
          folder. Not available while downloads are running.
        </p>
      </div>
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
        label="Keep the computer awake while playing"
        description="Hold a system wake lock while a tape is playing, so the screen won't dim and the computer won't sleep mid-watch. Released as soon as playback stops."
        checked={draft.keepAwakeWhilePlaying}
        disabled={busy}
        onChange={(v) => onPatch({ keepAwakeWhilePlaying: v })}
      />
      <TextField
        label="External player"
        value={draft.externalPlayer}
        placeholder="Blank = system default (e.g. VLC)"
        disabled={busy}
        onChange={(v) => onPatch({ externalPlayer: v })}
      />
      <div>
        <div className="text-xs font-medium text-zinc-300">Default export folder</div>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="text"
            value={draft.defaultExportDir}
            onChange={(e) => onPatch({ defaultExportDir: e.target.value })}
            placeholder="Blank = ask each time"
            spellCheck={false}
            disabled={busy}
            className={`flex-1 ${INPUT_CLASS}`}
          />
          <Button variant="secondary" size="sm" onClick={() => void chooseExportDir()} disabled={busy}>
            Choose…
          </Button>
        </div>
        <p className="mt-1 text-xs text-zinc-400">
          Where Export copies a tape's files. Blank means the export dialog asks each time.
        </p>
      </div>
      <Toggle
        label="Delete from library after export"
        description="After copying a tape's files out, remove it from TapeBox (respecting the Trash setting below). Off = keep the copy in the library too."
        checked={draft.deleteAfterExport}
        disabled={busy}
        onChange={(v) => onPatch({ deleteAfterExport: v })}
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
            <Button variant="dangerOutline" onClick={onClearKey} disabled={busy}>
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
            className={`w-full resize-y ${INPUT_CLASS}`}
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
              Reset to latest defaults
            </Button>
          </div>
          <p className="mt-1 text-xs text-zinc-400">
            Replaces the slug prompt with the latest built-in default. Save to persist;
            close without saving to keep your edits.
          </p>
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

        {draft.siteProfiles.length === 0 && (
          <p className="text-xs text-zinc-400">
            No site profiles yet. Add one to apply extra yt-dlp flags only to URLs that match a
            pattern — handy for a site that needs a specific header or format.
          </p>
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
              <Button variant="dangerOutline" size="sm" onClick={() => removeProfile(p.id)} disabled={busy}>
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
