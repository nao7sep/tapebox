import { Menu, MenuItem } from './Menu'
import { MoreVerticalIcon } from './Icon'
import { useModifierWord } from '@renderer/lib/useModifierWord'
import { useI18n } from '@renderer/i18n/I18nContext'

/**
 * Move up / Move down for a reorderable row (a tape or a box), reached from a
 * hover-revealed row menu — the trigger-then-MenuItem shape MoveToBoxButton
 * already uses. The trigger stays out of the row's own tab stop (tabIndex={-1}),
 * like the box row's rename/delete buttons: the row itself is the listbox's
 * non-focusable option, and a per-row action button is never a second tab stop
 * inside a composite control (composite-control-conventions). The keyboard
 * chord — Cmd/Ctrl+Shift+Up/Down, matched in useListboxKeyboard — keeps working
 * either way; this menu is the pointer-only way in, and names that same chord on
 * each item, styled like the shortcuts help modal's own key tokens
 * (keyboard-shortcut-conventions).
 */
export function RowMoveMenu({
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
}: {
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const t = useI18n()
  const mod = useModifierWord()

  // Nothing to offer at both ends of a one-row list — no menu, not an empty one.
  if (!canMoveUp && !canMoveDown) return null

  return (
    <Menu
      label={t.t('common.rowActions')}
      align="right"
      contentClassName="w-44 rounded-md border border-line bg-panel py-1 shadow-xl"
      trigger={({ ref, ...props }) => (
        <button
          {...props}
          ref={ref}
          aria-label={t.t('common.rowActions')}
          tabIndex={-1}
          className="hidden shrink-0 items-center justify-center rounded p-1 text-fg-muted transition hover:bg-hover-strong hover:text-fg-emphasis group-hover:inline-flex"
        >
          <MoreVerticalIcon />
        </button>
      )}
    >
      {canMoveUp && (
        <MenuItem onSelect={onMoveUp} className={itemClass}>
          <span>{t.t('common.moveUp')}</span>
          <kbd className={kbdClass}>{reorderChord(mod, 'Up')}</kbd>
        </MenuItem>
      )}
      {canMoveDown && (
        <MenuItem onSelect={onMoveDown} className={itemClass}>
          <span>{t.t('common.moveDown')}</span>
          <kbd className={kbdClass}>{reorderChord(mod, 'Down')}</kbd>
        </MenuItem>
      )}
    </Menu>
  )
}

// The row's own reorder chord (useListboxKeyboard's Cmd/Ctrl+Shift+Up/Down),
// spelled per the keyboard-shortcut-conventions and built outside JSX so it
// reads as a computed key token, not interface prose (tests/i18n/hardcoded-text).
function reorderChord(mod: 'Cmd' | 'Ctrl', direction: 'Up' | 'Down'): string {
  return mod + '+Shift+' + direction
}

const itemClass =
  'flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-sm text-fg transition hover:bg-raised hover:text-fg-strong'

// Same key-token look as the shortcuts help modal, so a chord reads the same
// wherever the app shows one.
const kbdClass = 'shrink-0 rounded border border-line bg-raised px-1.5 py-0.5 text-[11px] text-fg-emphasis'
