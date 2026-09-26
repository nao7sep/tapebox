import { useState, type RefObject } from 'react'
import type { Tape } from '@shared/domain'
import { ipcInvoke } from '@renderer/ipc/client'
import { useSettingsStore } from '@renderer/store/settings'
import { releaseVideo } from '@renderer/lib/video'
import { Modal } from '@renderer/components/Modal'
import { NameEditor } from '@renderer/components/NameEditor'
import { Button, Field, InlineError, Toggle } from '@renderer/components/ui'
import { presentFailure } from '@renderer/lib/presentFailure'
import { useI18n } from '@renderer/i18n/I18nContext'
import { message, type Message } from '@shared/i18n/translate'

type Props = { tape: Tape; videoRef: RefObject<HTMLVideoElement | null>; onClose: () => void }

/**
 * Export a tape out of the library: copy its files (media, thumbnail, sidecar) to
 * a destination folder, renaming them via the shared NameEditor, and optionally
 * removing the tape from the app afterwards. No transcoding — TapeBox does nothing
 * yt-dlp didn't already do.
 *
 * The destination starts from the configured default (Settings → General); if none
 * is set it's blank and the user must choose one before Export can run.
 */
export function ExportModal({ tape, videoRef, onClose }: Props) {
  const settings = useSettingsStore((s) => s.settings)
  const defaultDir = settings?.defaultExportDir?.trim() || null

  // Default to the tape's current on-disk name (filename without the extension), so
  // a plain export keeps that name; editing it renames only the exported copy.
  const currentName = tape.filename ? tape.filename.replace(/\.[^.]+$/, '') : (tape.name ?? '')
  const [name, setName] = useState(currentName)
  const [dir, setDir] = useState<string | null>(defaultDir)
  const [deleteFromApp, setDeleteFromApp] = useState(settings?.deleteAfterExport ?? true)
  const [generating, setGenerating] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<Message | null>(null)
  const t = useI18n()

  async function pickDir() {
    setError(null)
    try {
      const d = await ipcInvoke('dialog:pickDirectory', { title: t.t('export.pickerTitle') })
      if (d) setDir(d)
    } catch (err) {
      setError(presentFailure(err, message('common.folderPickerFailed'), 'export folder picker failed'))
    }
  }

  async function run() {
    if (!dir) return
    setError(null)
    setExporting(true)
    // Exporting only reads the file, which is safe while it plays — but with
    // "delete after export" the original is then trashed, so release the player
    // first (same precaution Rename and Remove take) so the file isn't in use.
    if (deleteFromApp) releaseVideo(videoRef.current)
    try {
      await ipcInvoke('export:files', { tapeId: tape.id, destinationDir: dir, name, deleteFromApp })
      onClose()
    } catch (err) {
      setError(presentFailure(err, message('export.failed'), 'tape export failed'))
      setExporting(false)
    }
  }

  const busy = exporting || generating
  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={exporting}>{t.t('common.cancel')}</Button>
      <Button
        variant="primary"
        onClick={() => void run()}
        disabled={!dir || !name.trim() || busy}
        loading={exporting}
      >
        {t.t(exporting ? 'export.exporting' : deleteFromApp ? 'export.exportAndRemove' : 'export.export')}
      </Button>
    </>
  )

  return (
    <Modal title={t.t('export.title')} onClose={onClose} size="2xl" footer={footer} closeDisabled={exporting}>
      <NameEditor
        tape={tape}
        value={name}
        onChange={setName}
        disabled={exporting}
        onGeneratingChange={setGenerating}
        label={t.t('export.name')}
        hint={t.t('export.nameHint')}
      />

      <div className="mt-4 space-y-4 border-t border-line pt-4">
        <Field label={t.t('export.destination')}>
          <div className="flex items-center gap-2">
            <code
              className={
                'min-w-0 flex-1 truncate rounded border bg-canvas px-2 py-1.5 text-xs ' +
                // Not set is a neutral placeholder, not a warning — choosing per-export
                // is a legitimate preference, so it stays muted rather than amber.
                (dir ? 'border-line text-fg' : 'border-dashed border-line text-fg-subtle')
              }
            >
              {dir ?? t.t('export.destinationUnset')}
            </code>
            <Button variant="secondary" size="sm" onClick={() => void pickDir()} disabled={busy}>
              {t.t('common.choose')}
            </Button>
          </div>
          {defaultDir && dir !== defaultDir && (
            <button
              type="button"
              onClick={() => setDir(defaultDir)}
              disabled={busy}
              className="mt-1 truncate text-xs text-fg-muted hover:text-fg-emphasis disabled:opacity-50"
            >
              {t.t('export.useDefault', { path: defaultDir })}
            </button>
          )}
          {!defaultDir && (
            <p className="mt-1 text-xs text-fg-muted">
              {t.t('export.setDefaultHint')}
            </p>
          )}
        </Field>

        <Toggle
          label={t.t('export.deleteAfter')}
          description={t.t('export.deleteAfterHint')}
          checked={deleteFromApp}
          disabled={busy}
          onChange={setDeleteFromApp}
        />
      </div>

      {error && <InlineError className="mt-4">{t.text(error)}</InlineError>}
    </Modal>
  )
}
