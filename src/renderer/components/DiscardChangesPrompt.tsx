import { ConfirmModal } from '@renderer/components/ConfirmModal'
import { useI18n } from '@renderer/i18n/I18nContext'

/**
 * The one question before an editor drops changes the user typed
 * (unsaved-edits-conventions): Keep editing, the safe default, or Discard.
 */
export function DiscardChangesPrompt({ onKeepEditing, onDiscard }: { onKeepEditing: () => void; onDiscard: () => void }) {
  const t = useI18n()
  return (
    <ConfirmModal
      title={t.t('common.unsavedTitle')}
      message={t.t('common.unsavedMessage')}
      cancelLabel={t.t('common.keepEditing')}
      confirmLabel={t.t('common.discard')}
      danger
      onCancel={onKeepEditing}
      onConfirm={onDiscard}
    />
  )
}
