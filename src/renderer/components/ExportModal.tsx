import { useMemo, useState } from 'react'
import type { Tape } from '@shared/domain'
import {
  EXPORT_PRESETS,
  AUDIO_BITRATES_KBPS,
  DEFAULT_AUDIO_BITRATE_KBPS,
  VIDEO_MAX_HEIGHTS,
  getPreset,
  supportsBitrate,
  supportsDownscale,
} from '@shared/export-presets'
import { ipcInvoke } from '@renderer/ipc/client'
import { Modal } from '@renderer/components/Modal'
import { Button, Field, INPUT_CLASS } from '@renderer/components/ui'

type Mode = 'whole' | 'perChapter'

type Props = { tape: Tape; onClose: () => void }

const DEFAULT_PRESET_ID = 'audio-copy'

/**
 * Transcode/extract a tape outside the box: pick a format preset (audio or
 * video), an optional quality knob (lossy-audio bitrate or video downscale),
 * and whole-or-per-chapter. Copy/remux presets re-use the source streams — no
 * re-encode. The preset catalog and its predicates live in @shared/export-presets.
 */
export function ExportModal({ tape, onClose }: Props) {
  const canPerChapter = (tape.chapterCount ?? 0) > 0

  const [mode, setMode] = useState<Mode>(canPerChapter ? 'perChapter' : 'whole')
  const [presetId, setPresetId] = useState(DEFAULT_PRESET_ID)
  const [bitrate, setBitrate] = useState<number>(DEFAULT_AUDIO_BITRATE_KBPS)
  const [maxHeight, setMaxHeight] = useState<number | null>(null)
  const [destinationDir, setDestinationDir] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ writtenPaths: string[] } | null>(null)

  const preset = useMemo(() => getPreset(presetId) ?? EXPORT_PRESETS[0]!, [presetId])
  const showBitrate = supportsBitrate(preset)
  const showDownscale = supportsDownscale(preset)

  async function pickDir() {
    const dir = await ipcInvoke('dialog:pickDirectory', { title: 'Choose export destination' })
    if (dir) setDestinationDir(dir)
  }

  async function run() {
    if (!destinationDir) return
    setBusy(true)
    setError(null)
    try {
      const r = await ipcInvoke('export:media', {
        tapeId: tape.id,
        destinationDir,
        mode,
        presetId: preset.id,
        audioBitrateKbps: showBitrate ? bitrate : null,
        maxHeight: showDownscale ? maxHeight : null,
      })
      setResult(r)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy}>
        {result ? 'Done' : 'Cancel'}
      </Button>
      {!result && (
        <Button variant="primary" onClick={() => void run()} disabled={busy || !destinationDir}>
          {busy ? 'Exporting…' : 'Export'}
        </Button>
      )}
    </>
  )

  return (
    <Modal title="Export" onClose={onClose} size="md" footer={footer} closeDisabled={busy}>
      <p className="-mt-2 mb-4 truncate text-xs text-zinc-300">{tape.title ?? tape.sourceUrl}</p>

      <div className="space-y-4">
        <Field label="Mode">
          <div className="flex gap-2">
            <Radio name="mode" value="whole" checked={mode === 'whole'} onChange={() => setMode('whole')}>
              Whole tape
            </Radio>
            <Radio name="mode" value="perChapter" checked={mode === 'perChapter'} disabled={!canPerChapter} onChange={() => setMode('perChapter')}>
              Per chapter ({tape.chapterCount ?? 0})
            </Radio>
          </div>
        </Field>

        <Field label="Format">
          <select
            className={INPUT_CLASS + ' w-full'}
            value={presetId}
            disabled={busy}
            onChange={(e) => setPresetId(e.target.value)}
          >
            <optgroup label="Audio">
              {EXPORT_PRESETS.filter((p) => p.kind === 'audio').map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </optgroup>
            <optgroup label="Video">
              {EXPORT_PRESETS.filter((p) => p.kind === 'video').map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </optgroup>
          </select>
          <p className="mt-1 text-xs text-zinc-300">
            Copy / remux re-uses the original streams — fast and lossless. Other formats re-encode.
          </p>
        </Field>

        {showBitrate && (
          <Field label="Audio bitrate">
            <select
              className={INPUT_CLASS + ' w-full'}
              value={bitrate}
              disabled={busy}
              onChange={(e) => setBitrate(Number(e.target.value))}
            >
              {AUDIO_BITRATES_KBPS.map((kbps) => (
                <option key={kbps} value={kbps}>{kbps} kbps</option>
              ))}
            </select>
          </Field>
        )}

        {showDownscale && (
          <Field label="Resolution">
            <select
              className={INPUT_CLASS + ' w-full'}
              value={maxHeight ?? ''}
              disabled={busy}
              onChange={(e) => setMaxHeight(e.target.value === '' ? null : Number(e.target.value))}
            >
              {VIDEO_MAX_HEIGHTS.map((h) => (
                <option key={h ?? 'orig'} value={h ?? ''}>
                  {h === null ? 'Original (no downscale)' : `${h}p`}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Destination">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs">
              {destinationDir ?? '(not chosen)'}
            </code>
            <Button variant="secondary" size="sm" onClick={() => void pickDir()} disabled={busy}>
              Choose
            </Button>
          </div>
        </Field>
      </div>

      {error && (
        <p className="mt-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
      )}
      {result && (
        <div className="mt-4 rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-300">
          Wrote {result.writtenPaths.length} {result.writtenPaths.length === 1 ? 'file' : 'files'}.
        </div>
      )}
    </Modal>
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
