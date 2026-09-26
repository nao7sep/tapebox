import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/ui'
import { useRuntimeStore } from '@renderer/store/runtime'
import { useI18n } from '@renderer/i18n/I18nContext'
import type { MessageKey } from '@shared/i18n/catalogues'

// Labels are catalogue keys; key tokens stay English in every language
// (keyboard-shortcut-conventions).
type Shortcut = { label: MessageKey; keys: string }
type Group = { title: MessageKey; note?: MessageKey; shortcuts: Shortcut[] }

/**
 * The keyboard map, grouped by where the keys apply. Kept in sync by hand with the
 * handlers that own them — the per-list listboxes (videos / boxes / chapters, via
 * useListboxKeyboard), DetailPane (the open tape: A, Backspace/Delete, Enter/R/E/M,
 * and Left/Right seek), and useAppShortcuts (navigation).
 */
function groups(mod: string): Group[] {
  return [
    {
      title: 'shortcuts.navigate',
      note: 'shortcuts.navigateNote',
      shortcuts: [
        { label: 'shortcuts.moveSelection', keys: 'Up / Down' },
        { label: 'shortcuts.reorder', keys: `${mod}+Shift+Up / Down` },
        { label: 'filter.inbox', keys: `${mod}+1` },
        { label: 'filter.archived', keys: `${mod}+2` },
        { label: 'shortcuts.searchArchive', keys: 'Slash' },
      ],
    },
    {
      // Same order as the detail-pane button row: primary action, then the
      // housekeeping group (refresh → rename → export), then archive, then remove.
      title: 'shortcuts.selectedTape',
      shortcuts: [
        { label: 'shortcuts.mainAction', keys: 'Enter' },
        { label: 'detail.refreshMetadata', keys: 'M' },
        { label: 'detail.rename', keys: 'R' },
        { label: 'detail.export', keys: 'E' },
        { label: 'shortcuts.archiveToggle', keys: 'A' },
        { label: 'remove.moveToTrash', keys: 'Backspace / Delete' },
      ],
    },
    {
      title: 'shortcuts.player',
      note: 'shortcuts.playerNote',
      shortcuts: [
        { label: 'shortcuts.seek', keys: 'Left / Right' },
        { label: 'shortcuts.jumpChapter', keys: 'Up / Down' },
      ],
    },
    {
      title: 'settings.tabGeneral',
      shortcuts: [
        { label: 'shortcuts.addUrl', keys: 'Enter' },
        { label: 'shortcuts.showList', keys: `${mod}+Slash / Question` },
        { label: 'shortcuts.closeDialog', keys: 'Escape' },
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
  const t = useI18n()

  return (
    <Modal
      title={t.t('menu.shortcuts')}
      onClose={onClose}
      size="md"
      footer={
        <Button variant="ghost" onClick={onClose}>
          {t.t('common.close')}
        </Button>
      }
    >
      <div className="space-y-5">
        {groups(mod).map((group) => (
          <section key={group.title}>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
              {t.t(group.title)}
              {group.note && <span className="ml-2 normal-case tracking-normal text-fg-subtle">{t.t(group.note)}</span>}
            </h3>
            <div className="space-y-2 text-sm">
              {group.shortcuts.map((s) => (
                <div key={s.label} className="flex items-center justify-between gap-4">
                  <span className="text-fg">{t.t(s.label)}</span>
                  <kbd className="shrink-0 rounded border border-line bg-raised px-2 py-1 text-xs text-fg-emphasis">
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
