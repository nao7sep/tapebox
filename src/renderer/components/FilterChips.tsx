import { useTapesStore } from '@renderer/store/tapes'
import { useFilterStore, type Filter } from '@renderer/store/filter'

const labels: Record<Filter, string> = {
  inbox: 'Inbox',
  archived: 'Archived',
}

const order: Filter[] = ['inbox', 'archived']

export function FilterChips() {
  const filter = useFilterStore((s) => s.filter)
  const setFilter = useFilterStore((s) => s.setFilter)
  const tapes = useTapesStore((s) => s.tapes)

  const counts: Record<Filter, number> = {
    inbox: tapes.filter((i) => !i.archivedAtUtc).length,
    archived: tapes.filter((i) => !!i.archivedAtUtc).length,
  }

  // A single-choice filter selector, so a native radio group: one tab stop, the
  // arrow keys move and select among the chips for free, and the checked state is
  // exposed to assistive tech. The radio input is visually hidden; the styled
  // label is the chip.
  return (
    <div role="radiogroup" aria-label="Tape filter" className="flex gap-2">
      {order.map((f) => {
        const active = f === filter
        return (
          <label
            key={f}
            className={
              'cursor-pointer rounded px-2.5 py-1 text-xs transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-fg-muted ' +
              (active
                ? 'bg-inverse text-on-inverse'
                : 'border border-line text-fg hover:border-line-strong')
            }
          >
            <input
              type="radio"
              name="tape-filter"
              className="sr-only"
              checked={active}
              onChange={() => setFilter(f)}
            />
            {labels[f]}
            <span className="ml-1.5 opacity-60">{counts[f]}</span>
          </label>
        )
      })}
    </div>
  )
}
