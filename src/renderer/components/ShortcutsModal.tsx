import { Modal } from '@renderer/components/Modal'
import { useRuntimeStore } from '@renderer/store/runtime'

type Shortcut = { label: string; keys: string }
type Group = { title: string; note?: string; shortcuts: Shortcut[] }

/**
 * The keyboard map, grouped by where the keys apply. Kept in sync by hand with the
 * three handlers that own them — useListKeyboard (selection), DetailPane (the open
 * tape), and useAppShortcuts (navigation) — plus the player's own native keys.
 */
function groups(mod: string): Group[] {
  return [
    {
      title: 'Navigate',
      shortcuts: [
        { label: 'Move selection up / down', keys: 'Up / Down' },
        { label: 'Inbox', keys: `${mod} 1` },
        { label: 'Archived', keys: `${mod} 2` },
        { label: 'Search the archive', keys: 'Slash' },
      ],
    },
    {
      // Same order as the detail-pane button row: primary action, then the
      // housekeeping group (refresh → rename → export), then archive, then remove.
      title: 'Selected tape',
      shortcuts: [
        { label: 'Play / pause, or the tape’s main action', keys: 'Enter' },
        { label: 'Refresh metadata', keys: 'M' },
        { label: 'Rename', keys: 'R' },
        { label: 'Export', keys: 'E' },
        { label: 'Archive / unarchive', keys: 'A' },
        { label: 'Move to Trash', keys: 'Backspace / Delete' },
      ],
    },
    {
      title: 'Player',
      note: 'when the video is focused',
      shortcuts: [
        { label: 'Play / pause', keys: 'Space' },
        { label: 'Seek back / forward', keys: 'Left / Right' },
        { label: 'Volume down / up', keys: 'Down / Up' },
      ],
    },
    {
      title: 'General',
      shortcuts: [
        { label: 'Add the URL in the input', keys: 'Enter' },
        { label: 'Show this list', keys: 'Question mark' },
        { label: 'Close a dialog', keys: 'Esc' },
      ],
    },
  ]
}

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  // Both Cmd and Ctrl trigger the modifier shortcuts everywhere; show the word for
  // this platform ("Cmd" on macOS, "Ctrl" elsewhere) — the ⌘ glyph reads as noise
  // to anyone who isn't on a Mac.
  const platform = useRuntimeStore((s) => s.info?.platform)
  const mod = platform === 'darwin' ? 'Cmd' : 'Ctrl'

  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} size="md">
      <div className="space-y-5">
        {groups(mod).map((group) => (
          <section key={group.title}>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
              {group.title}
              {group.note && <span className="ml-2 normal-case tracking-normal text-zinc-500">{group.note}</span>}
            </h3>
            <div className="space-y-2 text-sm">
              {group.shortcuts.map((s) => (
                <div key={s.label} className="flex items-center justify-between gap-4">
                  <span className="text-zinc-300">{s.label}</span>
                  <kbd className="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200">
                    {s.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  )
}
