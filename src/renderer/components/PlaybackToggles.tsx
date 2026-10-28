import { useEffect, useRef, type ReactNode } from 'react'
import { useSettingsStore, savePlaybackSettings } from '@renderer/store/settings'
import { useLayoutStore, patchLayout } from '@renderer/store/layout'
import { VOLUME_DEFAULT } from '@shared/layout'
import { InlineError } from '@renderer/components/ui'
import { LayoutWriteResult } from '@renderer/components/LayoutWriteResult'
import { useI18n } from '@renderer/i18n/I18nContext'

/** How long the slider must settle before the volume is written to disk. */
const PERSIST_DELAY_MS = 500

/**
 * App-wide playback controls, shown at the right of the Inbox/Archived row: the
 * Autoplay toggle (lit = on) and the playback volume, whose zero is mute. Both
 * read and write the stores the player uses, so they stay in sync with it.
 */
export function PlaybackToggles() {
  const autoplay = useSettingsStore((s) => s.settings?.autoplay ?? true)
  const savingAutoplay = useSettingsStore((s) => !!s.saving.autoplay)
  const t = useI18n()

  return (
    <div className="flex items-center gap-1.5">
      <ToggleButton
        on={autoplay}
        accent="text-autoplay-on"
        title={t.t(autoplay ? 'playback.autoplayOn' : 'playback.autoplayOff')}
        onClick={() => void savePlaybackSettings({ autoplay: !autoplay })}
        disabled={savingAutoplay}
        icon={autoplay ? <AutoplayOn /> : <AutoplayOff />}
      />
      <VolumeControl />
    </div>
  )
}

/**
 * The speaker icon shows the level, muted at zero. Dragging updates the mirror at
 * once (useVolume applies it to the live player) and writes the settled level, as
 * the player's own slider does.
 */
function VolumeControl() {
  const volume = useLayoutStore((s) => s.layout?.volume ?? VOLUME_DEFAULT)
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; volume: number } | null>(null)
  const t = useI18n()
  const percent = Math.round(volume * 100)

  useEffect(() => () => {
    if (!pending.current) return
    clearTimeout(pending.current.timer)
    void patchLayout({ volume: pending.current.volume }, true)
  }, [])

  const change = (next: number) => {
    void patchLayout({ volume: next }, false)
    if (pending.current) clearTimeout(pending.current.timer)
    pending.current = {
      volume: next,
      timer: setTimeout(() => {
        pending.current = null
        void patchLayout({ volume: next }, true)
      }, PERSIST_DELAY_MS),
    }
  }

  return (
    <span className={'flex items-center gap-1 ' + (percent > 0 ? 'text-sound-on' : 'text-fg-muted')}>
      <SpeakerIcon level={percent === 0 ? 0 : percent <= 33 ? 1 : percent <= 66 ? 2 : 3} />
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        aria-label={t.t('playback.volume')}
        title={t.t('playback.volume')}
        className="h-6 w-16 cursor-pointer accent-sound-on"
        onChange={(e) => change(Number(e.target.value) / 100)}
      />
    </span>
  )
}

export function PlaybackSettingResults() {
  const autoplay = useSettingsStore((s) => s.writeErrors.autoplay)
  const volume = useLayoutStore((s) => s.writeErrors.volume)
  const setWriteError = useSettingsStore((s) => s.setWriteError)
  const t = useI18n()
  if (!autoplay && !volume) return null
  return (
    <div className="space-y-2 border-t border-line px-3 py-2">
      {autoplay && (
        <InlineError onDismiss={() => setWriteError('autoplay', null)} closeLabel={t.t('playback.closeAutoplayResult')}>
          {t.text(autoplay)}
        </InlineError>
      )}
      <LayoutWriteResult field="volume" />
    </div>
  )
}

function ToggleButton({
  on,
  accent,
  title,
  onClick,
  icon,
  disabled,
}: {
  on: boolean
  /** Vivid text color class shown when on (drives the icon via currentColor). */
  accent: string
  title: string
  onClick: () => void
  icon: ReactNode
  disabled: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      title={title}
      className={'rounded p-1 -m-1 transition disabled:opacity-60 ' + (on ? accent : 'text-fg-muted hover:text-fg')}
    >
      {icon}
    </button>
  )
}

function AutoplayOn() {
  // On: a solid play triangle (Off is the same triangle outlined, with a strike).
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 5.5 L18.5 12 L7 18.5 Z" />
    </svg>
  )
}

function AutoplayOff() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d="M7 5.5 L18.5 12 L7 18.5 Z" />
      {/* A strike through the play triangle, extended past it on both ends so it
          reads as a strike-through rather than a paper-plane. Coordinates hand-tuned. */}
      <line x1="2" y1="7.5" x2="20" y2="18" />
    </svg>
  )
}

function SpeakerIcon({ level }: { level: 0 | 1 | 2 | 3 }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 L6 9 H3 V15 H6 L11 19 Z" fill="currentColor" stroke="none" />
      {level === 0 ? (
        <>
          <line x1="14" y1="9.5" x2="19" y2="14.5" />
          <line x1="19" y1="9.5" x2="14" y2="14.5" />
        </>
      ) : (
        <>
          <path d="M14 9.5 a3 3 0 0 1 0 5" />
          {level >= 2 && <path d="M16.5 7.5 a6 6 0 0 1 0 9" />}
          {level >= 3 && <path d="M19 5.5 a9 9 0 0 1 0 13" />}
        </>
      )}
    </svg>
  )
}
