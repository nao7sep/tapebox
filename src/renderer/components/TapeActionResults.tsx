import { useTapeActionResultsStore, type TapeAction } from '@renderer/store/tapeActionResults'
import { InlineError } from '@renderer/components/ui'

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

export function TapeActionResults({ tapeId, className = '' }: { tapeId: string; className?: string }) {
  const results = useTapeActionResultsStore((state) => state.byTape[tapeId])
  const setResult = useTapeActionResultsStore((state) => state.setResult)
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
            closeLabel={`Close ${action} result`}
          >
            {message}
          </InlineError>,
        ] : []
      })}
    </div>
  )
}
