import { IpcCallError } from '@shared/ipc-reply'
import { useWindowCloseGuard } from '@renderer/lib/windowClose'
import { useEffect, useState, useRef, useId, type KeyboardEvent } from 'react'
import { nanoid } from 'nanoid'
import type { Settings, SettingsSets, SiteProfile, ThemePreference } from '@shared/settings'
import { changedSettings, DEFAULT_AI_MODEL, DEFAULT_SLUG_PROMPT } from '@shared/settings'
import { rowFor, thinkingFor, type SupportedModel } from '@shared/ai-models'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import type { IpcCalls, IpcEvents } from '@shared/ipc-contract'
import { useSettingsStore } from '@renderer/store/settings'
import { useBoxesStore } from '@renderer/store/boxes'
import { useTapesStore } from '@renderer/store/tapes'
import { useToastStore } from '@renderer/store/toast'
import { Modal } from '@renderer/components/Modal'
import { ConfirmModal } from '@renderer/components/ConfirmModal'
import { DiscardChangesPrompt } from '@renderer/components/DiscardChangesPrompt'
import {
  AutoTextarea,
  Button,
  Field,
  INPUT_CLASS,
  INPUT_LINE_CLASS,
  NumberField,
  parseWholeNumber,
  Spinner,
  TextField,
  Toggle,
  InlineError,
} from '@renderer/components/ui'
import { presentFailure } from '@renderer/lib/presentFailure'
import { useI18n } from '@renderer/i18n/I18nContext'
import { message, type Message } from '@shared/i18n/translate'
import type { MessageKey } from '@shared/i18n/catalogues'
import { languageNameIn, LANGUAGE_NAMES, LANGUAGES, normalizeLanguagePreference } from '@shared/i18n/languages'
import { computerTimeZone, SYSTEM_TIME_ZONE, timeZoneChoices } from '@shared/time-zone'
import { apiKeyEnvVar } from '@shared/api-key-env'
import { MAX_CONCURRENT_DOWNLOADS } from '@shared/settings'
import { computerLanguage } from '@renderer/i18n/useInterfaceLanguage'

type Props = { onClose: () => void }
type Tab = 'general' | 'ai' | 'ytdlp'

/**
 * Settings is a draft form: every edit lives in local state, the footer Save
 * button commits changed settings first, then any API key change in a separate
 * IPC call. A credential failure leaves the settings saved and the dialog open
 * for retry. Closing with unsaved changes prompts a shared ConfirmModal to discard.
 *
 * The collection folder is a picker-backed field on the General tab, grouped with the
 * download settings. Leaving it blank uses the default folder (shown as the
 * field's placeholder); a set value points the collection at a custom folder. Changing
 * it moves every existing tape's files to the new folder as part of Save (main does
 * the move, then commits the setting), so a confirm prompts first; the move is
 * refused while downloads, imports, renames or exports are running. While it runs, the dialog shows its
 * progress and offers Stop Move, which rolls the copies back. Open an existing
 * collection instead switches to the selected collection on Save, leaving the current
 * collection in place; it never merges the two collections.
 */

type MoveProgress = IpcEvents['settings:collectionMoveProgress']
export function SettingsModal({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>('general')
  const [original, setOriginal] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Settings | null>(null)
  // What the concurrency field holds as typed; the draft takes it only while valid.
  const [concurrentText, setConcurrentText] = useState('')
  const [keyState, setKeyState] = useState<IpcCalls['settings:apiKeyState']['res']>('absent')
  const [defaultCollectionDir, setDefaultCollectionDir] = useState('')
  const [openExistingCollection, setOpenExistingCollection] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [wantsClearKey, setWantsClearKey] = useState(false)
  const [error, setError] = useState<Message | null>(null)
  const [busy, setBusy] = useState(false)
  const t = useI18n()
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [confirmOpenDiscard, setConfirmOpenDiscard] = useState(false)
  const [confirmMove, setConfirmMove] = useState<{ count: number } | null>(null)
  const [moveProgress, setMoveProgress] = useState<MoveProgress | null>(null)
  const [stoppingMove, setStoppingMove] = useState(false)
  // The last listed row the slug model field held, so passing through ids with no row keeps the thinking choice.
  const lastSlugRow = useRef<SupportedModel | undefined>(undefined)
  const [loadError, setLoadError] = useState<Message | null>(null)

  function load() {
    setLoadError(null)
    void Promise.all([
      ipcInvoke('settings:get'),
      ipcInvoke('settings:apiKeyState'),
      ipcInvoke('settings:defaultCollectionDir'),
    ]).then(([s, state, defaultLibDir]) => {
      setOriginal(s)
      setDraft(s)
      setConcurrentText(String(s.maxConcurrentDownloads))
      setKeyState(state)
      setDefaultCollectionDir(defaultLibDir)
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

  useEffect(() => ipcOn('settings:collectionMoveProgress', setMoveProgress), [])

  function stopMove() {
    setStoppingMove(true)
    void ipcInvoke('settings:cancelCollectionMove')
      .catch((err) => log.debug('collection move cancel failed', { error: describeError(err) }))
  }

  function patchDraft(patch: Partial<Settings>) {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  // An edit that reaches a listed row other than the last listed row the field
  // held resets the role's thinking to the new model's default, since models
  // accept different values; returning to that row keeps the choice, and an id
  // with no row keeps the stored value, hidden and not sent. A dialog opened on
  // an id with no row cannot know which row the stored value was chosen for, so
  // it keeps the value wherever the reached row lists it.
  function changeSlugModel(model: string) {
    setDraft((prev) => {
      if (!prev) return prev
      lastSlugRow.current = rowFor('openai', prev['openai.slug']) ?? lastSlugRow.current
      const row = rowFor('openai', model)
      const resets = row && (lastSlugRow.current
        ? row !== lastSlugRow.current
        : !row.thinking.includes(prev['openai.thinking.slug']))
      return {
        ...prev,
        'openai.slug': model,
        ...(resets ? { 'openai.thinking.slug': row.defaultThinking } : {}),
      }
    })
  }

  function patchPrompts(patch: Partial<Settings['prompts']>) {
    if (!draft) return
    patchDraft({ prompts: { ...draft.prompts, ...patch } })
  }

  const settingsDirty =
    !!original && !!draft && JSON.stringify(pickEditable(original)) !== JSON.stringify(pickEditable(draft))
  const apiKeyDirty = apiKeyDraft.length > 0 || wantsClearKey
  const concurrentInvalid =
    parseWholeNumber(concurrentText, MAX_CONCURRENT_DOWNLOADS.min, MAX_CONCURRENT_DOWNLOADS.max) === null
  const dirty = settingsDirty || apiKeyDirty || concurrentInvalid
  useWindowCloseGuard(() => ({ dirty }))

  // How many existing tapes have files on disk that a collection move would relocate.
  // Used only to decide whether to prompt before Save and to phrase the prompt;
  // main does the actual move and is the source of truth for what's moved.
  function tapesOnDiskCount(): number {
    return useTapesStore.getState().tapes.filter((t) => t.filename).length
  }

  // Compare effective strings: blank or whitespace-only values mean the default
  // folder; nonblank values are compared as entered. Switching between blank and
  // the explicit default is unchanged.
  function collectionDirChanged(): boolean {
    if (!original || !draft) return false
    const effective = (v: string) => v.trim() ? v : defaultCollectionDir
    return effective(original.collectionDir) !== effective(draft.collectionDir)
  }

  // Save splits into a request (which may prompt) and the commit. A collection move is
  // a real, user-visible relocation of their files, so it gets a confirm first when
  // there are tapes to move; everything else saves straight through.
  function changeConcurrentText(text: string) {
    setConcurrentText(text)
    const value = parseWholeNumber(text, MAX_CONCURRENT_DOWNLOADS.min, MAX_CONCURRENT_DOWNLOADS.max)
    if (value !== null) patchDraft({ maxConcurrentDownloads: value })
  }

  function requestSave() {
    if (!draft || concurrentInvalid) return
    const boxes = useBoxesStore.getState()
    if (openExistingCollection && collectionDirChanged() && boxes.editingId !== null &&
      boxes.draftName !== boxes.boxes.find((box) => box.id === boxes.editingId)?.name) {
      setConfirmOpenDiscard(true)
      return
    }
    const count = tapesOnDiskCount()
    if (!openExistingCollection && collectionDirChanged() && count > 0) {
      setConfirmMove({ count })
      return
    }
    void save()
  }

  async function save() {
    if (!draft || !original) return
    setConfirmMove(null)
    setBusy(true)
    setError(null)
    setMoveProgress(null)
    setStoppingMove(false)
    let settingsSaved = false
    try {
      const patch: SettingsSets = changedSettings(pickEditable(original), pickEditable(draft))
      if (Object.keys(patch).length > 0) {
        const { settings: updated, warning } = await ipcInvoke('settings:update', { ...patch, ...(openExistingCollection ? { collectionAction: 'open' as const } : {}) })
        // Not a rehydration: a playback toggle's own save may still be in flight.
        useSettingsStore.getState().setSettings(updated)
        setOriginal(updated)
        setDraft(updated)
        setConcurrentText(String(updated.maxConcurrentDownloads))
        // A committed save's cleanup warning remains after the dialog closes.
        if (warning) useToastStore.getState().notify(warning, 'error')
      }
      settingsSaved = true
      if (apiKeyDraft.length > 0) {
        await ipcInvoke('settings:setApiKey', { apiKey: apiKeyDraft })
      } else if (wantsClearKey) {
        await ipcInvoke('settings:clearApiKey')
      }
      onClose()
    } catch (err) {
      if (err instanceof IpcCallError && err.code === 'cancelled' && !settingsSaved) {
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
      <Button variant="primary" onClick={requestSave} disabled={!dirty || concurrentInvalid} loading={busy}>
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
                concurrentText={concurrentText}
                concurrentInvalid={concurrentInvalid}
                onConcurrentText={changeConcurrentText}
                defaultCollectionDir={defaultCollectionDir}
                openExistingCollection={openExistingCollection}
                onOpenExistingCollection={setOpenExistingCollection}
              />
            )}
            {tab === 'ai' && (
              <AiTab
                endpoint={draft['openai.endpoint']}
                model={draft['openai.slug']}
                thinking={draft['openai.thinking.slug']}
                onEndpointChange={(value) => patchDraft({ 'openai.endpoint': value })}
                onModelChange={changeSlugModel}
                onThinkingChange={(value) => patchDraft({ 'openai.thinking.slug': value })}
                onResetModel={() => changeSlugModel(DEFAULT_AI_MODEL)}
                prompts={draft.prompts}
                onPromptsPatch={patchPrompts}
                onResetPrompts={() => patchDraft({ prompts: { slug: DEFAULT_SLUG_PROMPT } })}
                busy={busy}
                keyState={keyState}
                apiKeyDraft={apiKeyDraft}
                wantsClearKey={wantsClearKey}
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
        {concurrentInvalid && tab !== 'general' && (
          <p className="mt-4 text-xs text-danger-fg">{t.t('settings.generalInvalid')}</p>
        )}
        {error && <InlineError className="mt-4">{t.text(error)}</InlineError>}
      </Modal>

      {confirmDiscard && (
        <DiscardChangesPrompt
          onKeepEditing={() => setConfirmDiscard(false)}
          onDiscard={() => {
            setConfirmDiscard(false)
            onClose()
          }}
        />
      )}

      {confirmOpenDiscard && (
        <DiscardChangesPrompt
          onKeepEditing={() => setConfirmOpenDiscard(false)}
          onDiscard={() => {
            setConfirmOpenDiscard(false)
            void save()
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
    collectionDir: s.collectionDir,
    autoStartDownloads: s.autoStartDownloads,
    maxConcurrentDownloads: s.maxConcurrentDownloads,
    autoplay: s.autoplay,
    keepAwakeWhilePlaying: s.keepAwakeWhilePlaying,
    trashOnRemove: s.trashOnRemove,
    confirmRemove: s.confirmRemove,
    externalPlayer: s.externalPlayer,
    defaultExportDir: s.defaultExportDir,
    deleteAfterExport: s.deleteAfterExport,
    uiFontFamily: s.uiFontFamily,
    theme: s.theme,
    language: s.language,
    timeZone: s.timeZone,
    'openai.endpoint': s['openai.endpoint'],
    'openai.slug': s['openai.slug'],
    'openai.thinking.slug': s['openai.thinking.slug'],
    prompts: s.prompts,
    ytdlpArgs: s.ytdlpArgs,
    siteProfiles: s.siteProfiles,
  }
}

/** The platform's zones, plus a saved one it lists under another name, so the
 * select always shows the saved choice. */
function zoneOptions(saved: string): readonly string[] {
  const zones = timeZoneChoices()
  return saved === SYSTEM_TIME_ZONE || zones.includes(saved) ? zones : [saved, ...zones]
}

// The prompt's template tokens, literal in every language.
const SLUG_TOKENS = ['{title}', '{uploader}', '{description}']

const THEME_LABELS: Record<Exclude<ThemePreference, 'system'>, MessageKey> = {
  light: 'settings.themeLight',
  dark: 'settings.themeDark',
}
const THEME_CHOICES: readonly ThemePreference[] = ['system', 'light', 'dark']

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
                ? 'bg-raised text-fg-strong hover:bg-raised-hover'
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
  concurrentText,
  concurrentInvalid,
  onConcurrentText,
  defaultCollectionDir,
  openExistingCollection,
  onOpenExistingCollection,
}: {
  draft: Settings
  busy: boolean
  onPatch: (p: Partial<Settings>) => void
  concurrentText: string
  concurrentInvalid: boolean
  onConcurrentText: (text: string) => void
  defaultCollectionDir: string
  openExistingCollection: boolean
  onOpenExistingCollection: (value: boolean) => void
}) {
  const [pickerError, setPickerError] = useState<Message | null>(null)
  const t = useI18n()
  // Every System choice names what it resolves to now, in the interface language;
  // a zone name appears as is (localization-conventions, Translation). Main knows
  // the OS appearance even while Light or Dark is forced.
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark' | null>(null)
  useEffect(() => {
    let current = true
    let running = false
    let pending = false
    async function refresh() {
      pending = true
      if (running) return
      running = true
      try {
        while (current && pending) {
          pending = false
          try {
            const appearance = await ipcInvoke('settings:systemAppearance')
            if (current) setSystemTheme(appearance)
          } catch (error) {
            if (current) setSystemTheme(null)
            log.debug('system appearance read failed', { error: describeError(error) })
          }
        }
      } finally { running = false }
    }
    const request = () => { void refresh() }
    const unsubscribe = ipcOn('settings:systemAppearanceChanged', request)
    window.addEventListener('focus', request)
    request()
    return () => {
      current = false
      unsubscribe()
      window.removeEventListener('focus', request)
    }
  }, [])
  const systemChoice = (value: string) => t.t('settings.systemChoice', { value })
  const themeLabel = (value: ThemePreference) =>
    value === 'system' ? systemChoice(systemTheme === null ? '—' : t.t(THEME_LABELS[systemTheme])) : t.t(THEME_LABELS[value])

  async function chooseExportDir() {
    setPickerError(null)
    try {
      const dir = await ipcInvoke('dialog:pickDirectory', { title: t.t('settings.pickExportFolder'), initialDirectory: draft.defaultExportDir })
      if (dir) onPatch({ defaultExportDir: dir })
    } catch (error) {
      setPickerError(presentFailure(error, message('common.folderPickerFailed'), 'settings export folder picker failed'))
    }
  }
  async function chooseCollectionDir() {
    setPickerError(null)
    try {
      const dir = await ipcInvoke('dialog:pickDirectory', { title: t.t('settings.pickCollectionFolder'), initialDirectory: draft.collectionDir.trim() ? draft.collectionDir : defaultCollectionDir })
      if (dir) onPatch({ collectionDir: dir })
    } catch (error) {
      setPickerError(presentFailure(error, message('common.folderPickerFailed'), 'settings collection folder picker failed'))
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
          className={`mt-1 block w-full text-ellipsis ${INPUT_LINE_CLASS}`}
        >
          <option value="system">{systemChoice(languageNameIn(computerLanguage(), t.language))}</option>
          {LANGUAGES.map((language) => (
            <option key={language} value={language} lang={language}>
              {LANGUAGE_NAMES[language]}
            </option>
          ))}
        </select>
      </label>
      {/* A native radio group: one tab stop, arrow keys move and select. Staged in
          the draft and applied on Save with the rest of Settings. */}
      <fieldset className="space-y-1.5" disabled={busy}>
        <legend className="mb-1 text-xs font-medium text-fg">{t.t('settings.theme')}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {THEME_CHOICES.map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="settings-theme"
                value={value}
                checked={draft.theme === value}
                onChange={() => onPatch({ theme: value })}
              />
              {themeLabel(value)}
            </label>
          ))}
        </div>
        <p className="text-xs text-fg-muted">{t.t('settings.themeHint')}</p>
      </fieldset>
      {/* The platform's IANA zones after System, chosen from a list and staged in
          the draft like the rest of Settings. */}
      <label className="block">
        <span className="text-xs font-medium text-fg">{t.t('settings.timeZone')}</span>
        <select
          value={draft.timeZone}
          disabled={busy}
          onChange={(e) => onPatch({ timeZone: e.target.value })}
          className={`mt-1 block w-full text-ellipsis ${INPUT_LINE_CLASS}`}
        >
          <option value={SYSTEM_TIME_ZONE}>{systemChoice(computerTimeZone())}</option>
          {zoneOptions(draft.timeZone).map((zone) => (
            <option key={zone} value={zone} data-literal>{zone}</option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-fg-muted">{t.t('settings.timeZoneHint')}</span>
      </label>
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
        text={concurrentText}
        error={concurrentInvalid
          ? t.t('settings.maxConcurrentInvalid', { min: MAX_CONCURRENT_DOWNLOADS.min, max: MAX_CONCURRENT_DOWNLOADS.max })
          : undefined}
        disabled={busy}
        onChange={onConcurrentText}
      />
      <div>
        <div className="text-xs font-medium text-fg">{t.t('settings.collectionFolder')}</div>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="text"
            value={draft.collectionDir}
            onChange={(e) => onPatch({ collectionDir: e.target.value })}
            placeholder={defaultCollectionDir}
            spellCheck={false}
            disabled={busy}
            className={`flex-1 ${INPUT_LINE_CLASS}`}
          />
          <Button variant="secondary" onClick={() => void chooseCollectionDir()} disabled={busy}>
            {t.t('common.choose')}
          </Button>
        </div>
        <p className="mt-1 text-xs text-fg-muted">
          {t.t(openExistingCollection ? 'settings.openCollectionHint' : 'settings.collectionFolderHint')}
        </p>
        <Toggle
          label={t.t('settings.openCollection')}
          checked={openExistingCollection}
          disabled={busy}
          onChange={onOpenExistingCollection}
        />
      </div>
      <Toggle
        label={t.t('settings.autoplay')}
        description={t.t('settings.autoplayHint')}
        checked={draft.autoplay}
        disabled={busy}
        onChange={(v) => onPatch({ autoplay: v })}
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
  endpoint, model, thinking, onEndpointChange, onModelChange, onThinkingChange, onResetModel,
  prompts,
  onPromptsPatch,
  onResetPrompts,
  busy,
  keyState,
  apiKeyDraft,
  wantsClearKey,
  onApiKeyChange,
  onClearKey,
}: {
  endpoint: string
  model: string
  thinking: string
  onEndpointChange: (value: string) => void
  onModelChange: (value: string) => void
  onThinkingChange: (value: string) => void
  onResetModel: () => void
  prompts: Settings['prompts']
  onPromptsPatch: (p: Partial<Settings['prompts']>) => void
  onResetPrompts: () => void
  busy: boolean
  keyState: IpcCalls['settings:apiKeyState']['res']
  apiKeyDraft: string
  wantsClearKey: boolean
  onApiKeyChange: (v: string) => void
  onClearKey: () => void
}) {
  const slugPromptId = useId()
  const apiKeyId = useId()
  const keyIsSet = keyState === 'set' && !wantsClearKey && apiKeyDraft.length === 0
  const willClear = wantsClearKey && apiKeyDraft.length === 0
  const t = useI18n()

  const row = rowFor('openai', model)

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-fg">{t.t('settings.openai')}</h3>
      <p className="text-xs text-fg-muted">{t.t('settings.onlyProvider')}</p>

      <div>
        <TextField
          label={t.t('settings.endpoint')}
          value={endpoint}
          disabled={busy}
          onChange={onEndpointChange}
        />
        <p className="mt-1 text-xs text-fg-muted">{t.t('settings.endpointHint')}</p>
      </div>

      <div>
        <label htmlFor={apiKeyId} className="text-xs font-medium text-fg">{t.t('settings.apiKey')}</label>
        {keyIsSet && <div className="mt-0.5 text-xs text-fg">{t.t('settings.apiKeySet')}</div>}
        <div className="mt-1 flex items-center gap-2">
          <input
            type="password"
            id={apiKeyId}
            value={apiKeyDraft}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={keyIsSet ? '••••••••' : undefined}
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
        <p className="mt-1 text-xs text-fg-muted">{t.t('settings.apiKeyHint', { variable: apiKeyEnvVar('openai') })}</p>
        {willClear && (
          <p className="mt-1 text-xs text-warning-fg">{t.t('settings.apiKeyWillClear')}</p>
        )}
        {keyState === 'unreadable' && (
          <p className="mt-1 text-xs text-warning-fg">{t.t('settings.apiKeyUnreadable')}</p>
        )}
        {keyState === 'newer' && (
          <p className="mt-1 text-xs text-warning-fg">{t.t('settings.apiKeyNewer')}</p>
        )}
      </div>

      <div>
        <label htmlFor="settings-openai-slug" className="text-xs font-medium text-fg">{t.t('settings.slugModel')}</label>
        <div className="mt-1 flex items-center gap-2">
          <input
            id="settings-openai-slug"
            type="text"
            value={model}
            spellCheck={false}
            disabled={busy}
            onChange={(e) => onModelChange(e.target.value)}
            className={`flex-1 ${INPUT_LINE_CLASS}`}
          />
          {/* A model name goes stale as providers retire models; this returns it
              to the one the current version ships (config-sets-conventions). */}
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={onResetModel}
          >
            {t.t('settings.resetModel')}
          </Button>
        </div>
        <p className="mt-1 text-xs text-fg-muted">{t.t('settings.slugModelHint')}</p>
        {!row && (
          <p className="mt-1 text-xs text-warning-fg">{t.t('settings.unsupportedModel')}</p>
        )}
      </div>

      {/* A row with one value offers no choice and an id with no row sends none,
          so neither shows the field. */}
      {row && row.thinking.length > 1 && (
        <div>
          <label className="block">
            <span className="text-xs font-medium text-fg">{t.t('settings.thinking')}</span>
            <select
              id="settings-openai-thinking-slug"
              value={thinkingFor(row, thinking)}
              disabled={busy}
              onChange={(e) => onThinkingChange(e.target.value)}
              className={`mt-1 block w-full text-ellipsis ${INPUT_LINE_CLASS}`}
            >
              {row.thinking.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <p className="mt-1 text-xs text-fg-muted">{t.t('settings.thinkingHint')}</p>
        </div>
      )}

      <div className="border-t border-line pt-4">
        <Field label={t.t('settings.slugPrompt')} htmlFor={slugPromptId}>
          <textarea
            id={slugPromptId}
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
              onClick={onResetPrompts}
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
      <p className="text-xs text-fg-muted">
        {t.t('settings.credentialHistoryHint')}
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
