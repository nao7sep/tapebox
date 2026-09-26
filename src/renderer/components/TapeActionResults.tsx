import { useTapeActionResultsStore, type TapeAction } from '@renderer/store/tapeActionResults'
import { InlineError } from '@renderer/components/ui'
import { useI18n } from '@renderer/i18n/I18nContext'
import type { MessageKey } from '@shared/i18n/catalogues'

const ACTION_ORDER: TapeAction[] = [
  'retry',
  'cancel',
  'open',
  'reveal',
  'open-url',
  'copy-url',
  'archive',
  'unarchive',
  'placement',
  'remove',
]

// Each result's close control names the action whose result it dismisses.
const CLOSE_LABEL: Record<TapeAction, MessageKey> = {
  retry: 'tapeActions.closeRetry',
  cancel: 'tapeActions.closeCancel',
  open: 'tapeActions.closeOpen',
  reveal: 'tapeActions.closeReveal',
  'open-url': 'tapeActions.closeOpenUrl',
  'copy-url': 'tapeActions.closeCopyUrl',
  archive: 'tapeActions.closeArchive',
  unarchive: 'tapeActions.closeUnarchive',
  placement: 'tapeActions.closePlacement',
  remove: 'tapeActions.closeRemove',
}

export function TapeActionResults({ tapeId, className = '' }: { tapeId: string; className?: string }) {
  const results = useTapeActionResultsStore((state) => state.byTape[tapeId])
  const setResult = useTapeActionResultsStore((state) => state.setResult)
  const t = useI18n()
  if (!results) return null

  return (
    <div
      className={`space-y-2 ${className}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {ACTION_ORDER.flatMap((action) => {
        const message = results[action]
        return message ? [
          <InlineError
            key={action}
            onDismiss={() => setResult(tapeId, action, null)}
            closeLabel={t.t(CLOSE_LABEL[action])}
          >
            {t.text(message)}
          </InlineError>,
        ] : []
      })}
    </div>
  )
}
