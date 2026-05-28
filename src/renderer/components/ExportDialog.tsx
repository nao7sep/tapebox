import { useState } from 'react'
import type { Item } from '@shared/domain'
import { ipcInvoke } from '@renderer/ipc/client'

type Mode = 'whole' | 'perChapter'
type Codec = 'copy' | 'mp3' | 'flac'

type Props = { item: Item; onClose: () => void }

/**
 * Export the item's audio outside the box.
 *   - "Lossless copy" (codec=copy) avoids re-encoding when source format permits.
 *   - perChapter requires chapter markers in the sidecar.
 */
export function ExportDialog({ item, onClose }: Props) {
  const [mode, setMode] = useState<Mode>(
    item.chapterCount && item.chapterCount > 0 ? 'perChapter' : 'whole',
  )
  const [codec, setCodec] = useState<Codec>('copy')
  const [destinationDir, setDestinationDir] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ writtenPaths: string[] } | null>(null)

  const canPerChapter = (item.chapterCount ?? 0) > 0

  async function pickDir() {
    const dir = await ipcInvoke('dialog:pickDirectory', { title: 'Choose export destination' })
    if (dir) setDestinationDir(dir)
  }

  async function run() {
    if (!destinationDir) return
    setBusy(true)
    setError(null)
    try {
      const r = await ipcInvoke('export:audio', {
        itemId: item.id,
        destinationDir,
        mode,
        codec,
      })
      setResult(r)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
        <h2 className="text-base font-medium">Export audio</h2>
        <p className="mt-1 truncate text-xs text-zinc-500">
          {item.title ?? item.sourceUrl}
        </p>

        <div className="mt-5 space-y-4">
          <Field label="Mode">
            <div className="flex gap-2">
              <Radio name="mode" value="whole" checked={mode === 'whole'} onChange={() => setMode('whole')}>
                Whole audio
              </Radio>
              <Radio name="mode" value="perChapter" checked={mode === 'perChapter'} disabled={!canPerChapter} onChange={() => setMode('perChapter')}>
                Per chapter ({item.chapterCount ?? 0})
              </Radio>
            </div>
          </Field>

          <Field label="Codec">
            <div className="flex gap-2">
              <Radio name="codec" value="copy" checked={codec === 'copy'} onChange={() => setCodec('copy')}>
                Lossless copy
              </Radio>
              <Radio name="codec" value="mp3" checked={codec === 'mp3'} onChange={() => setCodec('mp3')}>
                MP3
              </Radio>
              <Radio name="codec" value="flac" checked={codec === 'flac'} onChange={() => setCodec('flac')}>
                FLAC
              </Radio>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Lossless copy re-uses the original audio stream — fast, bit-perfect when source codec is compatible.
            </p>
          </Field>

          <Field label="Destination">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs">
                {destinationDir ?? '(not chosen)'}
              </code>
              <button
                onClick={pickDir}
                disabled={busy}
                className="rounded border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
              >
                Choose…
              </button>
            </div>
          </Field>
        </div>

        {error && (
          <p className="mt-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
        )}
        {result && (
          <div className="mt-4 rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300">
            Wrote {result.writtenPaths.length} {result.writtenPaths.length === 1 ? 'file' : 'files'}.
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800 disabled:opacity-50"
          >
            {result ? 'Done' : 'Cancel'}
          </button>
          {!result && (
            <button
              onClick={run}
              disabled={busy || !destinationDir}
              className="rounded bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              {busy ? 'Exporting…' : 'Export'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-zinc-400">{label}</div>
      {children}
    </div>
  )
}

function Radio({
  name, value, checked, disabled, onChange, children,
}: {
  name: string
  value: string
  checked: boolean
  disabled?: boolean
  onChange: () => void
  children: React.ReactNode
}) {
  return (
    <label className={'flex items-center gap-2 text-sm ' + (disabled ? 'opacity-50' : '')}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={onChange} />
      {children}
    </label>
  )
}
