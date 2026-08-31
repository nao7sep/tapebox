import { useState, type RefObject } from 'react'
import type { Tape } from '@shared/domain'
import { ipcInvoke } from '@renderer/ipc/client'
import { useSettingsStore } from '@renderer/store/settings'
import { releaseVideo } from '@renderer/lib/video'
import { Modal } from '@renderer/components/Modal'
import { NameEditor } from '@renderer/components/NameEditor'
import { Button, Field, InlineError, Toggle } from '@renderer/components/ui'

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
  const [error, setError] = useState<string | null>(null)

  async function pickDir() {
    const d = await ipcInvoke('dialog:pickDirectory', { title: 'Choose export destination' })
    if (d) setDir(d)
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
      setError(String(err))
      setExporting(false)
    }
  }

  const busy = exporting || generating
  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button
        variant="primary"
        onClick={() => void run()}
        disabled={!dir || !name.trim() || busy}
        loading={exporting}
      >
        {exporting ? 'Exporting…' : deleteFromApp ? 'Export and Remove' : 'Export'}
      </Button>
    </>
  )

  return (
    <Modal title="Export" onClose={onClose} size="2xl" footer={footer} closeDisabled={busy}>
      <NameEditor
        tape={tape}
        value={name}
        onChange={setName}
        disabled={exporting}
        onGeneratingChange={setGenerating}
        label="Export name"
        hint="Names the exported copy only — the tape in your library keeps its current name."
      />

      <div className="mt-4 space-y-4 border-t border-zinc-700 pt-4">
        <Field label="Destination">
          <div className="flex items-center gap-2">
            <code
              className={
                'min-w-0 flex-1 truncate rounded border bg-zinc-950 px-2 py-1.5 text-xs ' +
                // Not set is a neutral placeholder, not a warning — choosing per-export
                // is a legitimate preference, so it stays muted rather than amber.
                (dir ? 'border-zinc-700 text-zinc-300' : 'border-dashed border-zinc-700 text-zinc-500')
              }
            >
              {dir ?? 'Not set — choose a folder'}
            </code>
            <Button variant="secondary" size="sm" onClick={() => void pickDir()} disabled={busy}>
              Choose…
            </Button>
          </div>
          {defaultDir && dir !== defaultDir && (
            <button
              type="button"
              onClick={() => setDir(defaultDir)}
              disabled={busy}
              className="mt-1 truncate text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
            >
              Use default ({defaultDir})
            </button>
          )}
          {!defaultDir && (
            <p className="mt-1 text-xs text-zinc-400">
              Set a default export folder in Settings → General to skip choosing each time.
            </p>
          )}
        </Field>

        <Toggle
          label="Delete from library after export"
          description="Remove this tape from TapeBox once its files are copied out (respecting the Trash setting). Off = keep it in the library too."
          checked={deleteFromApp}
          disabled={busy}
          onChange={setDeleteFromApp}
        />
      </div>

      {error && <InlineError className="mt-4">{error}</InlineError>}
    </Modal>
  )
}
