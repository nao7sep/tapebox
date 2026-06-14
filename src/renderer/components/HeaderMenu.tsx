import { Menu, MenuItem } from '@renderer/components/Menu'

type Props = {
  onScanPage: () => void
  onImport: () => void
  onSettings: () => void
  onTools: () => void
  onShortcuts: () => void
  onAbout: () => void
  onRevealLog: () => void
}

/**
 * Hamburger menu in the header. Opens the app's modeless entry points; the shared
 * Menu owns the open/close, keyboard, and focus behavior (arrows, type-ahead, Esc,
 * outside click, focus return to the trigger).
 */
export function HeaderMenu({ onScanPage, onImport, onSettings, onTools, onShortcuts, onAbout, onRevealLog }: Props) {
  const entries: { label: string; action: () => void }[] = [
    { label: 'Scan a page', action: onScanPage },
    { label: 'Import files', action: onImport },
    { label: 'Settings', action: onSettings },
    { label: 'Required tools', action: onTools },
    { label: 'Keyboard shortcuts', action: onShortcuts },
    { label: 'Reveal session log', action: onRevealLog },
    { label: 'About', action: onAbout },
  ]

  return (
    <Menu
      label="Main menu"
      align="right"
      trigger={({ ref, ...props }) => (
        <button
          {...props}
          ref={ref}
          aria-label="Menu"
          className="flex items-center justify-center rounded-md p-2 -m-2 hover:bg-zinc-800"
        >
          <svg width="24" height="24" viewBox="3 3 18 18" aria-hidden="true">
            {/* bottom bun */}
            <path d="M3.8 16.6 H20.2 V18 Q20.2 20.8 12 20.8 Q3.8 20.8 3.8 18 Z" fill="#E3A857" />
            {/* beef patty */}
            <rect x="3" y="14.1" width="18" height="3.3" rx="1.6" fill="#6E4329" />
            {/* tomato */}
            <rect x="3.6" y="12.1" width="16.8" height="2.6" rx="1.3" fill="#E2574C" />
            {/* cheese with drips */}
            <path
              d="M3.6 9.9 H20.4 V11.5 L17.6 13.2 L14.8 11.5 L12 13.2 L9.2 11.5 L6.4 13.2 L3.6 11.5 Z"
              fill="#F6C544"
            />
            {/* top bun */}
            <path d="M3.4 10 C3.4 4.8 7.5 3.2 12 3.2 C16.5 3.2 20.6 4.8 20.6 10 Z" fill="#E3A857" />
            {/* sesame seeds */}
            <ellipse cx="9" cy="6.7" rx="0.95" ry="0.5" fill="#FBE9C7" transform="rotate(-22 9 6.7)" />
            <ellipse cx="12.2" cy="5.5" rx="0.95" ry="0.5" fill="#FBE9C7" />
            <ellipse cx="15.2" cy="6.9" rx="0.95" ry="0.5" fill="#FBE9C7" transform="rotate(22 15.2 6.9)" />
          </svg>
        </button>
      )}
    >
      {entries.map(({ label, action }) => (
        <MenuItem key={label} onSelect={action}>
          {label}
        </MenuItem>
      ))}
    </Menu>
  )
}
