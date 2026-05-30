import type { ReactNode } from 'react'
import { useSettingsStore, patchSettings } from '@renderer/store/settings'

/**
 * App-wide playback toggles, shown at the right of the Shelf/Archived row. Both
 * read and write the settings mirror, so they stay in sync with the Settings
 * dialog. Phrased positively so the two share a mental model: lit = enabled
 * (Autoplay on, Sound on).
 */
export function PlaybackToggles() {
  const autoplay = useSettingsStore((s) => s.settings?.autoplay ?? true)
  const playSound = useSettingsStore((s) => s.settings?.playSound ?? true)

  return (
    <div className="flex items-center gap-0.5">
      <ToggleButton
        on={autoplay}
        title={autoplay ? 'Autoplay: on' : 'Autoplay: off'}
        onClick={() => patchSettings({ autoplay: !autoplay }, true)}
        icon={autoplay ? <AutoplayOn /> : <AutoplayOff />}
      />
      <ToggleButton
        on={playSound}
        title={playSound ? 'Sound: on' : 'Sound: off'}
        onClick={() => patchSettings({ playSound: !playSound }, true)}
        icon={playSound ? <SoundOn /> : <SoundOff />}
      />
    </div>
  )
}

function ToggleButton({
  on,
  title,
  onClick,
  icon,
}: {
  on: boolean
  title: string
  onClick: () => void
  icon: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      title={title}
      className={'rounded p-1 transition ' + (on ? 'text-zinc-100' : 'text-zinc-600 hover:text-zinc-400')}
    >
      {icon}
    </button>
  )
}

function AutoplayOn() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 5.5 L18.5 12 L7 18.5 Z" />
    </svg>
  )
}

function AutoplayOff() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 5.5 L18.5 12 L7 18.5 Z" />
      <line x1="4" y1="4" x2="20" y2="20" strokeLinecap="round" />
    </svg>
  )
}

function SoundOn() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 L6 9 H3 V15 H6 L11 19 Z" fill="currentColor" stroke="none" />
      <path d="M15.5 8.8 a4 4 0 0 1 0 6.4" />
      <path d="M18.2 6.3 a8 8 0 0 1 0 11.4" />
    </svg>
  )
}

function SoundOff() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 L6 9 H3 V15 H6 L11 19 Z" fill="currentColor" stroke="none" />
      <line x1="15.5" y1="9.5" x2="20.5" y2="14.5" />
      <line x1="20.5" y1="9.5" x2="15.5" y2="14.5" />
    </svg>
  )
}
