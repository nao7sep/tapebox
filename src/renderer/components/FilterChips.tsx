import { useItemsStore } from '@renderer/store/items'
import { useFilterStore, type Filter } from '@renderer/store/filter'

const labels: Record<Filter, string> = {
  shelf: 'Shelf',
  archived: 'Archived',
}

const order: Filter[] = ['shelf', 'archived']

export function FilterChips() {
  const filter = useFilterStore((s) => s.filter)
  const setFilter = useFilterStore((s) => s.setFilter)
  const items = useItemsStore((s) => s.items)

  const counts: Record<Filter, number> = {
    shelf: items.filter((i) => !i.archivedAtUtc).length,
    archived: items.filter((i) => !!i.archivedAtUtc).length,
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
                : 'border border-zinc-800 text-zinc-300 hover:border-zinc-600')
            }
          >
            {labels[f]}
            <span className="ml-1.5 text-zinc-400">{counts[f]}</span>
          </button>
        )
      })}
    </div>
  )
}
