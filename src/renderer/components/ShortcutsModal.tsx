import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/ui'
import { useModifierWord } from '@renderer/lib/useModifierWord'
import { useI18n } from '@renderer/i18n/I18nContext'
import { SHORTCUT_GROUPS, shortcutKeys } from '@renderer/lib/shortcuts'

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  // Both Cmd and Ctrl trigger modifier shortcuts, except Ctrl while typing on
  // macOS belongs to the text system. Show this platform's word ("Cmd" on macOS,
  // "Ctrl" elsewhere) — the ⌘ glyph reads as noise to anyone who isn't on a Mac.
  const mod = useModifierWord()
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
        {SHORTCUT_GROUPS.map((group) => (
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
                    {shortcutKeys(s, mod)}
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
