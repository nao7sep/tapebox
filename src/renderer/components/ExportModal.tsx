import { useEffect, useMemo, useState } from 'react'
import type { Tape } from '@shared/domain'
import {
  EXPORT_PRESETS,
  AUDIO_BITRATES_KBPS,
  DEFAULT_AUDIO_BITRATE_KBPS,
  VIDEO_MAX_HEIGHTS,
  VIDEO_FPS_CAPS,
  AUDIO_CHANNEL_OPTIONS,
  VIDEO_QUALITY_OPTIONS,
  ENCODE_SPEED_OPTIONS,
  DEFAULT_VIDEO_QUALITY,
  DEFAULT_ENCODE_SPEED,
  getPreset,
  supportsBitrate,
  supportsDownscale,
  reencodesAudio,
  reencodesVideo,
  type AudioChannels,
  type EncodeSpeed,
  type VideoQuality,
} from '@shared/export-presets'
import { DEFAULT_CHAPTER_TEMPLATE, applyChapterTemplate } from '@shared/export-filename'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { Modal } from '@renderer/components/Modal'
import { Button, Field, INPUT_CLASS } from '@renderer/components/ui'

/** Newest-first cap on the live ffmpeg log, matching the download log's bound. */
const MAX_LOG_LINES = 300

type Mode = 'whole' | 'perChapter'

type Props = { tape: Tape; onClose: () => void }

const DEFAULT_PRESET_ID = 'audio-copy'

/**
 * Transcode/extract a tape outside the box. The format preset fixes the
 * container + codecs; the audio and video sections appear only when the chosen
 * preset re-encodes that stream, exposing the knobs people actually reach for
 * (bitrate, channels, loudness; quality, speed, resolution, frame rate). Output
 * naming is editable — a filename for the whole tape, a token template for
 * per-chapter splits. The catalog and predicates live in @shared/export-presets.
 */
export function ExportModal({ tape, onClose }: Props) {
  const canPerChapter = (tape.chapterCount ?? 0) > 0
  const baseStem = tape.slug ?? tape.sourceId ?? tape.id

  const [mode, setMode] = useState<Mode>(canPerChapter ? 'perChapter' : 'whole')
  const [presetId, setPresetId] = useState(DEFAULT_PRESET_ID)
  const [bitrate, setBitrate] = useState<number>(DEFAULT_AUDIO_BITRATE_KBPS)
  const [channels, setChannels] = useState<AudioChannels>('source')
  const [normalize, setNormalize] = useState(false)
  const [maxHeight, setMaxHeight] = useState<number | null>(null)
  const [quality, setQuality] = useState<VideoQuality>(DEFAULT_VIDEO_QUALITY)
  const [speed, setSpeed] = useState<EncodeSpeed>(DEFAULT_ENCODE_SPEED)
  const [fpsCap, setFpsCap] = useState<number | null>(null)
  const [filenameStem, setFilenameStem] = useState('')
  const [template, setTemplate] = useState(DEFAULT_CHAPTER_TEMPLATE)
  const [destinationDir, setDestinationDir] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ writtenPaths: string[] } | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])

  // Stream ffmpeg's output (newest first) while an export runs — no parsing, just
  // proof that work is flowing. One export at a time (this modal blocks), so a
  // global subscription is enough.
  useEffect(() => {
    return ipcOn('export:log', ({ line }) =>
      setLogLines((prev) => [line, ...prev].slice(0, MAX_LOG_LINES)),
    )
  }, [])

  const preset = useMemo(() => getPreset(presetId) ?? EXPORT_PRESETS[0]!, [presetId])
  const showBitrate = supportsBitrate(preset)
  const showAudio = reencodesAudio(preset)
  const showVideo = reencodesVideo(preset)
  const showDownscale = supportsDownscale(preset)

  const templatePreview = applyChapterTemplate(template, {
    slug: baseStem,
    index: 1,
    chapterTitle: 'chapter-title',
  })

  async function pickDir() {
    const dir = await ipcInvoke('dialog:pickDirectory', { title: 'Choose export destination' })
    if (dir) setDestinationDir(dir)
  }

  async function run() {
    if (!destinationDir) return
    setBusy(true)
    setError(null)
    setLogLines([])
    try {
      const r = await ipcInvoke('export:media', {
        tapeId: tape.id,
        destinationDir,
        mode,
        presetId: preset.id,
        audioBitrateKbps: showBitrate ? bitrate : null,
        audioChannels: showAudio ? channels : null,
        normalizeAudio: showAudio ? normalize : false,
        maxHeight: showDownscale ? maxHeight : null,
        videoQuality: showVideo ? quality : null,
        encodeSpeed: showVideo ? speed : null,
        fpsCap: showVideo ? fpsCap : null,
        filenameStem: mode === 'whole' ? filenameStem.trim() || undefined : undefined,
        filenameTemplate: mode === 'perChapter' ? template : undefined,
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
        <Button variant="primary" onClick={() => void run()} disabled={!destinationDir} loading={busy}>
          {busy ? 'Exporting…' : 'Export'}
        </Button>
      )}
    </>
  )

  return (
    <Modal title="Export" onClose={onClose} size="2xl" footer={footer} closeDisabled={busy}>
      <p className="-mt-2 mb-4 truncate text-xs text-zinc-400">{tape.title ?? tape.sourceUrl}</p>

      <div className="space-y-4">
        <Field label="Mode">
          <div className="flex gap-4">
            <Radio name="mode" checked={mode === 'whole'} disabled={busy} onChange={() => setMode('whole')}>
              Whole tape
            </Radio>
            <Radio name="mode" checked={mode === 'perChapter'} disabled={busy || !canPerChapter} onChange={() => setMode('perChapter')}>
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
          <p className="mt-1 text-xs text-zinc-400">
            Copy / remux re-uses the original streams — fast and lossless. Other formats re-encode.
          </p>
        </Field>

        {showAudio && (
          <Section title="Audio">
            <div className="grid grid-cols-2 gap-3">
              {showBitrate && (
                <Field label="Bitrate">
                  <select className={INPUT_CLASS + ' w-full'} value={bitrate} disabled={busy} onChange={(e) => setBitrate(Number(e.target.value))}>
                    {AUDIO_BITRATES_KBPS.map((kbps) => (
                      <option key={kbps} value={kbps}>{kbps} kbps</option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Channels">
                <select className={INPUT_CLASS + ' w-full'} value={channels} disabled={busy} onChange={(e) => setChannels(e.target.value as AudioChannels)}>
                  {AUDIO_CHANNEL_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </Field>
            </div>
            <label className={'mt-3 flex items-center gap-2 text-sm ' + (busy ? 'opacity-50' : 'cursor-pointer')}>
              <input type="checkbox" checked={normalize} disabled={busy} onChange={(e) => setNormalize(e.target.checked)} />
              Normalize loudness
            </label>
          </Section>
        )}

        {showVideo && (
          <Section title="Video">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Resolution">
                <select className={INPUT_CLASS + ' w-full'} value={maxHeight ?? ''} disabled={busy} onChange={(e) => setMaxHeight(e.target.value === '' ? null : Number(e.target.value))}>
                  {VIDEO_MAX_HEIGHTS.map((h) => (
                    <option key={h ?? 'orig'} value={h ?? ''}>{h === null ? 'Original' : `${h}p`}</option>
                  ))}
                </select>
              </Field>
              <Field label="Frame rate">
                <select className={INPUT_CLASS + ' w-full'} value={fpsCap ?? ''} disabled={busy} onChange={(e) => setFpsCap(e.target.value === '' ? null : Number(e.target.value))}>
                  {VIDEO_FPS_CAPS.map((f) => (
                    <option key={f ?? 'src'} value={f ?? ''}>{f === null ? 'Source' : `${f} fps`}</option>
                  ))}
                </select>
              </Field>
              <Field label="Quality">
                <select className={INPUT_CLASS + ' w-full'} value={quality} disabled={busy} onChange={(e) => setQuality(e.target.value as VideoQuality)}>
                  {VIDEO_QUALITY_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Encode speed">
                <select className={INPUT_CLASS + ' w-full'} value={speed} disabled={busy} onChange={(e) => setSpeed(e.target.value as EncodeSpeed)}>
                  {ENCODE_SPEED_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </Field>
            </div>
          </Section>
        )}

        {mode === 'whole' ? (
          <Field label="Filename">
            <input
              type="text"
              value={filenameStem}
              onChange={(e) => setFilenameStem(e.target.value)}
              placeholder={baseStem}
              spellCheck={false}
              disabled={busy}
              className={`w-full ${INPUT_CLASS}`}
            />
            <p className="mt-1 text-xs text-zinc-400">Blank uses the tape's name. The extension is added automatically.</p>
          </Field>
        ) : (
          <Field label="Filename template">
            <input
              type="text"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              spellCheck={false}
              disabled={busy}
              className={`w-full font-mono ${INPUT_CLASS}`}
            />
            <p className="mt-1 text-xs text-zinc-400">
              Tokens: <code>{'{slug}'}</code>, <code>{'{index}'}</code>, <code>{'{index:02}'}</code>,{' '}
              <code>{'{chapterTitle}'}</code>. Example: <span className="text-zinc-300">{templatePreview}</span>
            </p>
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

      {busy && (
        <div className="mt-4 overflow-hidden rounded border border-zinc-700 bg-zinc-950">
          <div className="border-b border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300">
            Exporting…
          </div>
          <div className="max-h-40 overflow-auto p-3 font-mono text-xs">
            {logLines.length > 0 ? (
              <ul className="space-y-0.5">
                {logLines.map((l, i) => (
                  <li key={i} className="whitespace-pre-wrap break-words text-zinc-400">{l}</li>
                ))}
              </ul>
            ) : (
              <p className="text-zinc-500">Starting ffmpeg…</p>
            )}
          </div>
        </div>
      )}

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

/** A titled group of related controls, divided from the rest like the AI tab. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-zinc-800 p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">{title}</div>
      {children}
    </div>
  )
}

function Radio({
  name, checked, disabled, onChange, children,
}: {
  name: string
  checked: boolean
  disabled?: boolean
  onChange: () => void
  children: React.ReactNode
}) {
  return (
    <label className={'flex items-center gap-2 text-sm ' + (disabled ? 'opacity-50' : 'cursor-pointer')}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onChange} />
      {children}
    </label>
  )
}
