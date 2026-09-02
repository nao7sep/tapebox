import type { ReactNode } from 'react'
import { useSettingsStore, savePlaybackSettings } from '@renderer/store/settings'
import { InlineError } from '@renderer/components/ui'

/**
 * App-wide playback toggles, shown at the right of the Inbox/Archived row. Both
 * read and write the settings mirror, so they stay in sync with the Settings
 * dialog. Phrased positively so the two share a mental model: lit = enabled
 * (Autoplay on, Sound on).
 */
export function PlaybackToggles() {
  const autoplay = useSettingsStore((s) => s.settings?.autoplay ?? true)
  const playSound = useSettingsStore((s) => s.settings?.playSound ?? true)
  const savingAutoplay = useSettingsStore((s) => !!s.saving.autoplay)
  const savingSound = useSettingsStore((s) => !!s.saving.playSound)

  return (
    <div className="flex items-center gap-1.5">
      <ToggleButton
        on={autoplay}
        accent="text-sky-400"
        title={autoplay ? 'Autoplay: on' : 'Autoplay: off'}
        onClick={() => void savePlaybackSettings({ autoplay: !autoplay })}
        disabled={savingAutoplay}
        icon={autoplay ? <AutoplayOn /> : <AutoplayOff />}
      />
      <ToggleButton
        on={playSound}
        accent="text-pink-400"
        title={playSound ? 'Sound: on' : 'Sound: off'}
        onClick={() => void savePlaybackSettings({ playSound: !playSound })}
        disabled={savingSound}
        icon={playSound ? <SoundOn /> : <SoundOff />}
      />
    </div>
  )
}

export function PlaybackSettingResults() {
  const autoplay = useSettingsStore((s) => s.writeErrors.autoplay)
  const playSound = useSettingsStore((s) => s.writeErrors.playSound)
  const setWriteError = useSettingsStore((s) => s.setWriteError)
  if (!autoplay && !playSound) return null
  return (
    <div className="space-y-2 border-t border-zinc-700 px-3 py-2">
      {autoplay && (
        <InlineError onDismiss={() => setWriteError('autoplay', null)} closeLabel="Close autoplay save result">
          {autoplay}
        </InlineError>
      )}
      {playSound && (
        <InlineError onDismiss={() => setWriteError('playSound', null)} closeLabel="Close sound save result">
          {playSound}
        </InlineError>
      )}
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
      className={'rounded p-1 -m-1 transition disabled:cursor-wait disabled:opacity-60 ' + (on ? accent : 'text-zinc-400 hover:text-zinc-300')}
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

function SoundOn() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 L6 9 H3 V15 H6 L11 19 Z" fill="currentColor" stroke="none" />
      <path d="M13 9 a3.5 3.5 0 0 1 0 6" />
      <path d="M15.5 6.8 a7 7 0 0 1 0 10.4" />
    </svg>
  )
}

function SoundOff() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 L6 9 H3 V15 H6 L11 19 Z" fill="currentColor" stroke="none" />
      <line x1="13.5" y1="9.5" x2="18.5" y2="14.5" />
      <line x1="18.5" y1="9.5" x2="13.5" y2="14.5" />
    </svg>
  )
}
