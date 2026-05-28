import { useItemsStore } from '@renderer/store/items'
import { useFilterStore, type Filter } from '@renderer/store/filter'

const labels: Record<Filter, string> = {
  inbox: 'Inbox',
  archived: 'Archived',
  failed: 'Failed',
  all: 'All',
}

export function FilterChips() {
  const filter = useFilterStore((s) => s.filter)
  const setFilter = useFilterStore((s) => s.setFilter)
  const items = useItemsStore((s) => s.items)

  const counts: Record<Filter, number> = {
    inbox: items.filter((i) => !i.archivedAtUtc && i.state !== 'failed').length,
    archived: items.filter((i) => !!i.archivedAtUtc).length,
    failed: items.filter((i) => i.state === 'failed').length,
    all: items.length,
  }

  const order: Filter[] = ['inbox', 'archived', 'failed', 'all']

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
            <span className={'ml-1.5 ' + (active ? 'text-zinc-500' : 'text-zinc-500')}>
              {counts[f]}
            </span>
          </button>
        )
      })}
    </div>
  )
}
