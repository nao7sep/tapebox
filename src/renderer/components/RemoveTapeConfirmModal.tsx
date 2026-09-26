import type { Tape } from '@shared/domain'
import { ConfirmModal } from '@renderer/components/ConfirmModal'
import { useI18n } from '@renderer/i18n/I18nContext'

type Props = {
  tape: Tape
  trashEnabled: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Confirmation for removing a tape from the library. The message and commit
 * label adapt to the tape's state: a still-downloading tape has no file to
 * remove; otherwise the wording reflects whether files go to the Trash
 * (restorable) or are deleted permanently, per the trash-on-remove setting.
 *
 * The removal orchestration (pending state, video-handle release, selection
 * advance) lives in the useTapeRemoval hook; this is just the named surface so
 * the confirm is findable by filename rather than buried in the hook.
 */
export function RemoveTapeConfirmModal({ tape, trashEnabled, onCancel, onConfirm }: Props) {
  const t = useI18n()
  return (
    <ConfirmModal
      title={t.t('remove.title')}
      message={t.t(
        !tape.filename
          ? 'remove.messageNoFile'
          : trashEnabled
            ? 'remove.messageTrash'
            : 'remove.messageDelete',
      )}
      confirmLabel={t.t(!tape.filename ? 'common.remove' : trashEnabled ? 'remove.moveToTrash' : 'remove.delete')}
      danger
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
