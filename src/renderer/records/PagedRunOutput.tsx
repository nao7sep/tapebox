import { useEffect, useRef, useState } from 'react'
import type { RunOutputPage, RunOutputQuery } from '@shared/records'
import { useI18n } from '@renderer/i18n/I18nContext'
import { ipcInvoke } from '@renderer/ipc/client'
import { Button } from '@renderer/components/ui/Button'
import { textBlock } from './record-format'

type Props = Omit<RunOutputQuery, 'page'> & { label: string; initial: RunOutputPage }
type Page = { number: number } & (
  { status: 'ready'; output: RunOutputPage } | { status: 'loading' } | { status: 'failed' }
)

/** A record or stream change retires the prior page and its pending request. */
export function PagedRunOutput(props: Props) {
  return <OutputPage key={`${props.kind}:${props.id}:${props.stream}`} {...props} />
}

function OutputPage({ kind, id, stream, label, initial }: Props) {
  const t = useI18n()
  const [page, setPage] = useState<Page>({ number: 0, status: 'ready', output: initial })
  const generation = useRef(0)
  useEffect(() => () => { generation.current += 1 }, [])

  const load = (number: number): void => {
    const current = ++generation.current
    setPage({ number, status: 'loading' })
    void ipcInvoke('records:output', { kind, id, stream, page: number }).then(
      (output) => { if (generation.current === current) setPage({ number, status: 'ready', output }) },
      () => { if (generation.current === current) setPage({ number, status: 'failed' }) },
    )
  }
  if (page.number === 0 && page.status === 'ready' && textBlock(page.output.text) === null && !page.output.more) return null
  const navigation = page.number > 0 || (page.status === 'ready' && page.output.more)
  return (
    <section className="min-w-0" data-records-block aria-busy={page.status === 'loading'}>
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</h3>
      {page.status === 'ready' ? (
        <pre className="whitespace-pre-wrap rounded border border-line bg-panel px-3 py-2 font-mono text-xs text-fg wrap-anywhere" data-literal>
          {textBlock(page.output.text)}
        </pre>
      ) : page.status === 'loading' ? (
        <p className="text-sm text-fg-muted">{t.t('common.loading')}</p>
      ) : (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-danger-fg">{t.t('records.outputFailed')}</p>
          <Button variant="ghost" size="sm" onClick={() => load(page.number)}>{t.t('common.tryAgain')}</Button>
        </div>
      )}
      {navigation && (
        <div className="mt-2 flex gap-2">
          <Button variant="ghost" size="sm" disabled={page.number === 0 || page.status === 'loading'} onClick={() => load(page.number - 1)}>
            {t.t('records.outputPrevious')}
          </Button>
          <Button variant="ghost" size="sm" disabled={page.status !== 'ready' || !page.output.more} onClick={() => load(page.number + 1)}>
            {t.t('records.outputNext')}
          </Button>
        </div>
      )}
    </section>
  )
}
