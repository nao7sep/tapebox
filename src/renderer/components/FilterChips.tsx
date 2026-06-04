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

  return (
    <div className="flex gap-1">
      {order.map((f) => {
        const active = f === filter
        return (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={
              'rounded px-2.5 py-1 text-xs transition ' +
              (active
                ? 'bg-zinc-100 text-zinc-950'
                : 'border border-zinc-700 text-zinc-300 hover:border-zinc-600')
            }
          >
            {labels[f]}
            <span className="ml-1.5 text-zinc-300">{counts[f]}</span>
          </button>
        )
      })}
    </div>
  )
}
