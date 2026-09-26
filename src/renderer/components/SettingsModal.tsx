import { useEffect, useState, useRef, type KeyboardEvent } from 'react'
import { nanoid } from 'nanoid'
import type { AiSettings, Settings, SiteProfile, ThemePreference } from '@shared/settings'
import { DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, DEFAULT_SLUG_PROMPT } from '@shared/settings'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import type { IpcEvents } from '@shared/ipc-contract'
import { useSettingsStore } from '@renderer/store/settings'
import { useTapesStore } from '@renderer/store/tapes'
import { useToastStore } from '@renderer/store/toast'
import { Modal } from '@renderer/components/Modal'
import { ConfirmModal } from '@renderer/components/ConfirmModal'
import {
  AutoTextarea,
  Button,
  Field,
  INPUT_CLASS,
  INPUT_LINE_CLASS,
  NumberField,
  Spinner,
  TextField,
  Toggle,
  InlineError,
} from '@renderer/components/ui'
import { presentFailure } from '@renderer/lib/presentFailure'
import { useI18n } from '@renderer/i18n/I18nContext'
import { message, type Message } from '@shared/i18n/translate'
import { CATALOGUES, type MessageKey } from '@shared/i18n/catalogues'
import { LANGUAGES, normalizeLanguagePreference } from '@shared/i18n/languages'

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
 * refused while downloads, imports, renames or exports are running. While it runs, the dialog shows its
 * progress and offers Stop Move, which rolls the copies back.
 */

type MoveProgress = IpcEvents['settings:libraryMoveProgress']
export function SettingsModal({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>('general')
  const [original, setOriginal] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [hadApiKey, setHadApiKey] = useState(false)
  const [defaultLibraryDir, setDefaultLibraryDir] = useState('')
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [wantsClearKey, setWantsClearKey] = useState(false)
  const [error, setError] = useState<Message | null>(null)
  const [busy, setBusy] = useState(false)
  const t = useI18n()
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [confirmMove, setConfirmMove] = useState<{ count: number } | null>(null)
  const [moveProgress, setMoveProgress] = useState<MoveProgress | null>(null)
  const [stoppingMove, setStoppingMove] = useState(false)
  // Read by save() after the rejected update, so a requested stop is not reported as a failure.
  const stopRequested = useRef(false)
  const [loadError, setLoadError] = useState<Message | null>(null)

  function load() {
    setLoadError(null)
    void Promise.all([
      ipcInvoke('settings:get'),
      ipcInvoke('settings:hasApiKey'),
      ipcInvoke('settings:defaultLibraryDir'),
    ]).then(([s, has, defaultLibDir]) => {
      setOriginal(s)
      setDraft(s)
      setHadApiKey(has)
      setDefaultLibraryDir(defaultLibDir)
    }, (error) => {
      setLoadError(presentFailure(
        error,
        message('settings.loadFailed'),
        'settings dialog hydration failed',
      ))
    })
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => ipcOn('settings:libraryMoveProgress', setMoveProgress), [])

  function stopMove() {
    stopRequested.current = true
    setStoppingMove(true)
    void ipcInvoke('settings:cancelLibraryMove')
      .catch((err) => log.debug('library move cancel failed', { error: describeError(err) }))
  }

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
    setMoveProgress(null)
    setStoppingMove(false)
    stopRequested.current = false
    let settingsSaved = false
    try {
      const { settings: updated, warning } = await ipcInvoke('settings:update', pickEditable(draft))
      useSettingsStore.getState().setHydratedSettings(updated)
      settingsSaved = true
      // The save committed; a leftover problem main reports stays on screen after
      // the dialog closes, since an error toast persists until dismissed.
      if (warning) useToastStore.getState().notify(warning, 'error')
      if (apiKeyDraft.length > 0) {
        await ipcInvoke('settings:setApiKey', { apiKey: apiKeyDraft })
      } else if (wantsClearKey) {
        await ipcInvoke('settings:clearApiKey')
      }
      onClose()
    } catch (err) {
      if (stopRequested.current && !settingsSaved) {
        setError(message('settings.moveStopped'))
        return
      }
      setError(presentFailure(
        err,
        message(settingsSaved ? 'settings.apiKeySaveFailed' : 'settings.saveFailed'),
        settingsSaved ? 'API key save failed' : 'settings save failed',
      ))
    } finally {
      setBusy(false)
      setMoveProgress(null)
      setStoppingMove(false)
    }
  }

  function requestClose() {
    if (busy) return
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }

  if (!draft) {
    return (
      <Modal title={t.t('settings.title')} onClose={onClose} size="2xl">
        {loadError ? (
          <div className="space-y-3">
            <InlineError>{t.text(loadError)}</InlineError>
            <Button variant="secondary" onClick={load}>{t.t('common.tryAgain')}</Button>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-fg">
            <Spinner /> {t.t('common.loading')}
          </p>
        )}
      </Modal>
    )
  }

  const moving = busy && moveProgress !== null
  const footer = (
    <>
      {moving ? (
        <Button variant="ghost" onClick={stopMove} disabled={stoppingMove}>
          {t.t(stoppingMove ? 'settings.stoppingMove' : 'settings.stopMove')}
        </Button>
      ) : (
        <Button variant="ghost" onClick={requestClose} disabled={busy}>
          {t.t('common.cancel')}
        </Button>
      )}
      <Button variant="primary" onClick={requestSave} disabled={!dirty} loading={busy}>
        {t.t(moving ? 'settings.moving' : busy ? 'common.saving' : 'common.save')}
      </Button>
    </>
  )

  return (
    <>
      <Modal
        title={t.t('settings.title')}
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

        {moving && (
          <p className="mt-4 flex items-center gap-2 text-sm text-fg" role="status">
            <Spinner />
            {t.t('settings.moveProgress', {
              done: moveProgress.filesDone,
              count: moveProgress.filesTotal,
              bytesDone: t.bytes(moveProgress.bytesDone),
              bytesTotal: t.bytes(moveProgress.bytesTotal),
            })}
          </p>
        )}
        {error && <InlineError className="mt-4">{t.text(error)}</InlineError>}
      </Modal>

      {confirmDiscard && (
        <ConfirmModal
          title={t.t('settings.unsavedTitle')}
          message={t.t('settings.unsavedMessage')}
          cancelLabel={t.t('settings.keepEditing')}
          confirmLabel={t.t('settings.discard')}
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
          title={t.t('settings.moveTitle')}
          message={t.t('settings.moveMessage', { count: confirmMove.count })}
          confirmLabel={t.t('settings.move')}
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
    theme: s.theme,
    language: s.language,
    ai: s.ai,
    prompts: s.prompts,
    ytdlpArgs: s.ytdlpArgs,
    siteProfiles: s.siteProfiles,
  }
}

// The prompt's template tokens, literal in every language.
const SLUG_TOKENS = ['{title}', '{uploader}', '{description}']

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: MessageKey }> = [
  { value: 'system', label: 'settings.themeSystem' },
  { value: 'light', label: 'settings.themeLight' },
  { value: 'dark', label: 'settings.themeDark' },
]

const TABS: { id: Tab; label: MessageKey }[] = [
  { id: 'general', label: 'settings.tabGeneral' },
  { id: 'ai', label: 'settings.tabAi' },
  { id: 'ytdlp', label: 'settings.tabYtdlp' },
]

// A vertical tablist: one tab stop (the active tab via roving tabindex), Up/Down
// move and activate immediately (switching a settings panel is cheap), Home/End
// jump to the ends, and the arrows stop at the ends rather than wrapping.
function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const listRef = useRef<HTMLDivElement>(null)
  const activeIndex = TABS.findIndex((entry) => entry.id === tab)
  const t = useI18n()

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
      aria-label={t.t('settings.sections')}
      onKeyDown={onKeyDown}
      className="w-32 shrink-0 space-y-0.5"
    >
      {TABS.map((entry, i) => {
        const selected = tab === entry.id
        return (
          <button
            key={entry.id}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-tab-index={i}
            onClick={() => onTab(entry.id)}
            className={
              'block w-full rounded px-3 py-1.5 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fg-muted ' +
              (selected
                ? 'bg-raised text-fg-strong'
                : 'text-fg hover:bg-hover hover:text-fg-strong')
            }
          >
            {t.t(entry.label)}
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
  const [pickerError, setPickerError] = useState<Message | null>(null)
  const t = useI18n()

  async function chooseExportDir() {
    setPickerError(null)
    try {
      const dir = await ipcInvoke('dialog:pickDirectory', { title: t.t('settings.pickExportFolder') })
      if (dir) onPatch({ defaultExportDir: dir })
    } catch (error) {
      setPickerError(presentFailure(error, message('common.folderPickerFailed'), 'settings export folder picker failed'))
    }
  }
  async function chooseLibraryDir() {
    setPickerError(null)
    try {
      const dir = await ipcInvoke('dialog:pickDirectory', { title: t.t('settings.pickLibraryFolder') })
      if (dir) onPatch({ libraryDir: dir })
    } catch (error) {
      setPickerError(presentFailure(error, message('common.folderPickerFailed'), 'settings library folder picker failed'))
    }
  }
  return (
    <div className="space-y-4">
      {pickerError && (
        <InlineError onDismiss={() => setPickerError(null)} closeLabel={t.t('settings.closePickerResult')}>
          {t.text(pickerError)}
        </InlineError>
      )}
      {/* Each language is listed by its own name, in its own script, so a reader
          of any of them can find it whatever language is showing. Staged in the
          draft and applied on Save with the rest of Settings. */}
      <label className="block">
        <span className="text-xs font-medium text-fg">{t.t('settings.language')}</span>
        <select
          value={draft.language}
          disabled={busy}
          onChange={(e) => onPatch({ language: normalizeLanguagePreference(e.target.value) })}
          className={`mt-1 block w-full ${INPUT_LINE_CLASS}`}
        >
          <option value="system">{t.t('settings.languageSystem')}</option>
          {LANGUAGES.map((language) => (
            <option key={language} value={language} lang={language}>
              {CATALOGUES[language]['language.name'] as string}
            </option>
          ))}
        </select>
      </label>
      {/* A native radio group: one tab stop, arrow keys move and select. Staged in
          the draft and applied on Save with the rest of Settings. */}
      <fieldset className="space-y-1.5" disabled={busy}>
        <legend className="mb-1 text-xs font-medium text-fg">{t.t('settings.theme')}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {THEME_OPTIONS.map(({ value, label }) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="settings-theme"
                value={value}
                checked={draft.theme === value}
                onChange={() => onPatch({ theme: value })}
              />
              {t.t(label)}
            </label>
          ))}
        </div>
        <p className="text-xs text-fg-muted">{t.t('settings.themeHint')}</p>
      </fieldset>
      <div>
        <TextField
          label={t.t('settings.uiFont')}
          value={draft.uiFontFamily}
          placeholder={t.t('settings.uiFontPlaceholder')}
          disabled={busy}
          onChange={(v) => onPatch({ uiFontFamily: v })}
        />
        <p className="mt-1 text-xs text-fg-muted">
          {t.t('settings.uiFontHint')}
        </p>
      </div>
      <Toggle
        label={t.t('settings.autostart')}
        description={t.t('settings.autostartHint')}
        checked={draft.autoStartDownloads}
        disabled={busy}
        onChange={(v) => onPatch({ autoStartDownloads: v })}
      />
      <NumberField
        label={t.t('settings.maxConcurrent')}
        value={draft.maxConcurrentDownloads}
        min={1}
        max={8}
        disabled={busy}
        onChange={(v) => onPatch({ maxConcurrentDownloads: v })}
      />
      <div>
        <div className="text-xs font-medium text-fg">{t.t('settings.libraryFolder')}</div>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="text"
            value={draft.libraryDir}
            onChange={(e) => onPatch({ libraryDir: e.target.value })}
            placeholder={defaultLibraryDir}
            spellCheck={false}
            disabled={busy}
            className={`flex-1 ${INPUT_LINE_CLASS}`}
          />
          <Button variant="secondary" onClick={() => void chooseLibraryDir()} disabled={busy}>
            {t.t('common.choose')}
          </Button>
        </div>
        <p className="mt-1 text-xs text-fg-muted">
          {t.t('settings.libraryFolderHint')}
        </p>
      </div>
      <Toggle
        label={t.t('settings.autoplay')}
        description={t.t('settings.autoplayHint')}
        checked={draft.autoplay}
        disabled={busy}
        onChange={(v) => onPatch({ autoplay: v })}
      />
      <Toggle
        label={t.t('settings.playSound')}
        description={t.t('settings.playSoundHint')}
        checked={draft.playSound}
        disabled={busy}
        onChange={(v) => onPatch({ playSound: v })}
      />
      <Toggle
        label={t.t('settings.keepAwake')}
        description={t.t('settings.keepAwakeHint')}
        checked={draft.keepAwakeWhilePlaying}
        disabled={busy}
        onChange={(v) => onPatch({ keepAwakeWhilePlaying: v })}
      />
      <TextField
        label={t.t('settings.externalPlayer')}
        value={draft.externalPlayer}
        placeholder={t.t('settings.externalPlayerPlaceholder')}
        disabled={busy}
        onChange={(v) => onPatch({ externalPlayer: v })}
      />
      <div>
        <div className="text-xs font-medium text-fg">{t.t('settings.defaultExportFolder')}</div>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="text"
            value={draft.defaultExportDir}
            onChange={(e) => onPatch({ defaultExportDir: e.target.value })}
            placeholder={t.t('settings.defaultExportPlaceholder')}
            spellCheck={false}
            disabled={busy}
            className={`flex-1 ${INPUT_LINE_CLASS}`}
          />
          <Button variant="secondary" onClick={() => void chooseExportDir()} disabled={busy}>
            {t.t('common.choose')}
          </Button>
        </div>
        <p className="mt-1 text-xs text-fg-muted">
          {t.t('settings.defaultExportHint')}
        </p>
      </div>
      <Toggle
        label={t.t('export.deleteAfter')}
        description={t.t('settings.deleteAfterExportHint')}
        checked={draft.deleteAfterExport}
        disabled={busy}
        onChange={(v) => onPatch({ deleteAfterExport: v })}
      />
      <Toggle
        label={t.t('settings.confirmRemove')}
        description={t.t('settings.confirmRemoveHint')}
        checked={draft.confirmRemove}
        disabled={busy}
        onChange={(v) => onPatch({ confirmRemove: v })}
      />
      <Toggle
        label={t.t('settings.trashOnRemove')}
        description={t.t('settings.trashOnRemoveHint')}
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
  const t = useI18n()

  function resetModelToDefault() {
    onAiPatch({ model: DEFAULT_AI_MODEL })
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg">
        {t.t('settings.aiIntro')}
      </p>

      <TextField
        label={t.t('settings.baseUrl')}
        value={ai.baseUrl}
        placeholder={DEFAULT_AI_BASE_URL}
        disabled={busy}
        onChange={(v) => onAiPatch({ baseUrl: v })}
      />

      <div>
        <div className="text-xs font-medium text-fg">{t.t('settings.apiKey')}</div>
        {keyIsSet && <div className="mt-0.5 text-xs text-fg">{t.t('settings.apiKeySet')}</div>}
        <div className="mt-1 flex items-center gap-2">
          <input
            type="password"
            value={apiKeyDraft}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={keyIsSet ? '••••••••' : 'sk-…'}
            spellCheck={false}
            disabled={busy}
            className={`flex-1 ${INPUT_LINE_CLASS}`}
          />
          {keyIsSet && (
            <Button variant="dangerOutline" onClick={onClearKey} disabled={busy}>
              {t.t('settings.clearKey')}
            </Button>
          )}
        </div>
        {willClear && (
          <p className="mt-1 text-xs text-warning-fg">{t.t('settings.apiKeyWillClear')}</p>
        )}
      </div>

      <div>
        <label htmlFor="settings-ai-model" className="text-xs font-medium text-fg">{t.t('settings.model')}</label>
        <div className="mt-1 flex items-center gap-2">
          <input
            id="settings-ai-model"
            type="text"
            value={ai.model}
            placeholder={DEFAULT_AI_MODEL}
            spellCheck={false}
            disabled={busy}
            onChange={(e) => onAiPatch({ model: e.target.value })}
            className={`flex-1 ${INPUT_LINE_CLASS}`}
          />
          {/* A model name goes stale as providers retire models; this returns it
              to the one the current version ships (config-seeding-conventions). */}
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || ai.model === DEFAULT_AI_MODEL}
            onClick={resetModelToDefault}
          >
            {t.t('settings.resetModel')}
          </Button>
        </div>
      </div>

      <div className="border-t border-line pt-4">
        <Field label={t.t('settings.slugPrompt')}>
          <textarea
            value={prompts.slug}
            rows={7}
            spellCheck={false}
            disabled={busy}
            onChange={(e) => onPromptsPatch({ slug: e.target.value })}
            className={`w-full resize-y ${INPUT_CLASS}`}
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <p className="text-xs text-fg">
              {t.rich('settings.slugTokens', {
                tokens: new Intl.ListFormat(t.locale, { style: 'narrow', type: 'conjunction' })
                  .formatToParts(SLUG_TOKENS)
                  .map((part, index) => (part.type === 'element' ? <code key={index}>{part.value}</code> : part.value)),
              })}
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || prompts.slug === DEFAULT_SLUG_PROMPT}
              onClick={() => onPromptsPatch({ slug: DEFAULT_SLUG_PROMPT })}
            >
              {t.t('settings.resetSlugPrompt')}
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
  const t = useI18n()

  return (
    <div className="space-y-4">
      <p className="text-xs text-fg-muted">
        {t.t('settings.ytdlpIntro')}
      </p>

      <div>
        <div className="text-xs font-medium text-fg">{t.t('settings.globalArgs')}</div>
        <div className="mt-1">
          <AutoTextarea
            value={draft.ytdlpArgs}
            onChange={(v) => onPatch({ ytdlpArgs: v })}
            placeholder={'--add-header "Accept-Language: ja"\n--sleep-requests "1"'}
            disabled={busy}
            mono
            minRows={4}
          />
        </div>
        <p className="mt-1 text-xs text-fg-muted">
          {t.t('settings.globalArgsHint')}
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium text-fg">{t.t('settings.siteProfiles')}</div>
          <Button variant="secondary" size="sm" onClick={addProfile} disabled={busy}>
            {t.t('settings.addProfile')}
          </Button>
        </div>

        {draft.siteProfiles.length === 0 && (
          <p className="text-xs text-fg-muted">
            {t.t('settings.noProfiles')}
          </p>
        )}

        {draft.siteProfiles.map((p) => (
          <div key={p.id} className="space-y-2 rounded border border-line p-3">
            <div className="flex items-center gap-2">
              <input
                value={p.name}
                onChange={(e) => patchProfile(p.id, { name: e.target.value })}
                placeholder={t.t('settings.profileName')}
                spellCheck={false}
                disabled={busy}
                className={`flex-1 ${INPUT_LINE_CLASS}`}
              />
              <Button variant="dangerOutline" size="sm" onClick={() => removeProfile(p.id)} disabled={busy}>
                {t.t('common.remove')}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={p.urlPattern}
                onChange={(e) => patchProfile(p.id, { urlPattern: e.target.value })}
                placeholder={t.t('settings.profilePattern')}
                spellCheck={false}
                disabled={busy}
                className={`flex-1 ${INPUT_LINE_CLASS}`}
              />
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-fg">
                <input
                  type="checkbox"
                  checked={p.isRegex}
                  onChange={(e) => patchProfile(p.id, { isRegex: e.target.checked })}
                  disabled={busy}
                />
                {t.t('settings.regex')}
              </label>
            </div>
            <AutoTextarea
              value={p.args}
              onChange={(v) => patchProfile(p.id, { args: v })}
              placeholder={'--add-header "Accept-Language: ja" -f bestvideo+bestaudio'}
              disabled={busy}
              mono
              minRows={3}
            />
            <AutoTextarea
              value={p.comment}
              onChange={(v) => patchProfile(p.id, { comment: v })}
              placeholder={t.t('settings.profileComment')}
              disabled={busy}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
