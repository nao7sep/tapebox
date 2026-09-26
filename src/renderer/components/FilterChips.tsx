import { useTapesStore } from '@renderer/store/tapes'
import { useFilterStore, type Filter } from '@renderer/store/filter'
import { useI18n } from '@renderer/i18n/I18nContext'
import type { MessageKey } from '@shared/i18n/catalogues'

const labels: Record<Filter, MessageKey> = {
  inbox: 'filter.inbox',
  archived: 'filter.archived',
}

const order: Filter[] = ['inbox', 'archived']

export function FilterChips() {
  const filter = useFilterStore((s) => s.filter)
  const setFilter = useFilterStore((s) => s.setFilter)
  const tapes = useTapesStore((s) => s.tapes)
  const t = useI18n()

  const counts: Record<Filter, number> = {
    inbox: tapes.filter((i) => !i.archivedAtUtc).length,
    archived: tapes.filter((i) => !!i.archivedAtUtc).length,
  }

  // A single-choice filter selector, so a native radio group: one tab stop, the
  // arrow keys move and select among the chips for free, and the checked state is
  // exposed to assistive tech. The radio input is visually hidden; the styled
  // label is the chip.
  return (
    <div role="radiogroup" aria-label={t.t('filter.label')} className="inline-flex gap-0.5 rounded-md bg-raised p-0.5 inset-ring inset-ring-line">
      {order.map((f) => {
        const active = f === filter
        return (
          <label
            key={f}
            className={
              'flex h-7 cursor-pointer items-center rounded px-2.5 text-xs transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-fg-muted ' +
              (active
                ? 'bg-inverse text-on-inverse'
                : 'text-fg hover:bg-raised-hover')
            }
          >
            <input
              type="radio"
              name="tape-filter"
              className="sr-only"
              checked={active}
              onChange={() => setFilter(f)}
            />
            {t.t(labels[f])}
            <span className="ml-1.5 opacity-60">{counts[f]}</span>
          </label>
        )
      })}
    </div>
  )
}
