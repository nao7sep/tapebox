import type { Item } from '@shared/domain'
import { useItemsStore } from '@renderer/store/items'
import { useSelectionStore } from '@renderer/store/selection'
import { useFilterStore, type Filter } from '@renderer/store/filter'
import { ItemRow } from './ItemRow'

export function ItemList() {
  const items = useItemsStore((s) => s.items)
  const progress = useItemsStore((s) => s.progress)
  const selectedId = useSelectionStore((s) => s.selectedId)
  const select = useSelectionStore((s) => s.select)
  const filter = useFilterStore((s) => s.filter)

  const visible = items
    .filter((i) => matchesFilter(i, filter))
    .sort((a, b) => b.addedAtUtc.localeCompare(a.addedAtUtc))

  if (visible.length === 0) {
    return (
      <div className="p-6 text-sm text-zinc-400">
        {emptyMessageFor(filter)}
      </div>
    )
  }

  return (
    <ul className="space-y-1 p-3">
      {visible.map((item) => (
        <li key={item.id}>
          <ItemRow
            item={item}
            progress={progress[item.id]}
            selected={item.id === selectedId}
            onSelect={() => select(item.id)}
          />
        </li>
      ))}
    </ul>
  )
}

function matchesFilter(item: Item, filter: Filter): boolean {
  switch (filter) {
    case 'inbox':    return !item.archivedAtUtc && item.state !== 'failed'
    case 'archived': return !!item.archivedAtUtc
    case 'failed':   return item.state === 'failed'
    case 'all':      return true
  }
}

function emptyMessageFor(filter: Filter): string {
  switch (filter) {
    case 'inbox':    return 'Inbox zero. Paste a URL to add a tape.'
    case 'archived': return 'No archived tapes yet.'
    case 'failed':   return 'No failed downloads.'
    case 'all':      return 'The box is empty.'
  }
}
