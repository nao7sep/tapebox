import type { LayoutField } from '@renderer/store/layout'
import { useLayoutStore } from '@renderer/store/layout'
import { InlineError } from '@renderer/components/ui'

export function LayoutWriteResult({ field, className = '' }: { field: LayoutField; className?: string }) {
  const message = useLayoutStore((state) => state.writeErrors[field])
  const setWriteError = useLayoutStore((state) => state.setWriteError)
  if (!message) return null
  return (
    <InlineError
      className={className}
      onDismiss={() => setWriteError(field, null)}
      closeLabel="Close layout save result"
    >
      {message}
    </InlineError>
  )
}
