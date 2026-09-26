import type { LayoutField } from '@renderer/store/layout'
import { useLayoutStore } from '@renderer/store/layout'
import { InlineError } from '@renderer/components/ui'
import { useI18n } from '@renderer/i18n/I18nContext'

export function LayoutWriteResult({ field, className = '' }: { field: LayoutField; className?: string }) {
  const message = useLayoutStore((state) => state.writeErrors[field])
  const setWriteError = useLayoutStore((state) => state.setWriteError)
  const t = useI18n()
  if (!message) return null
  return (
    <InlineError
      className={className}
      onDismiss={() => setWriteError(field, null)}
      closeLabel={t.t('layout.closeResult')}
    >
      {t.text(message)}
    </InlineError>
  )
}
