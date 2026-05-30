import { useItemsStore } from '@renderer/store/items'
import { useSelectionStore } from '@renderer/store/selection'
import { useFilterStore, type Filter } from '@renderer/store/filter'
import { useVisibleItems } from '@renderer/lib/itemOrder'
import { ItemRow } from './ItemRow'

/**
 * One continuous list per tab. The filter and sort that define the on-screen
 * order live in lib/itemOrder, so the list view, keyboard navigation, and
 * removal all agree on which item is next.
 */
export function ItemList() {
  const progress = useItemsStore((s) => s.progress)
  const selectedId = useSelectionStore((s) => s.selectedId)
  const select = useSelectionStore((s) => s.select)
  const filter = useFilterStore((s) => s.filter)
  const visible = useVisibleItems()

  if (visible.length === 0) {
    return (
      <div className="p-6 text-sm text-zinc-400">
        {emptyMessageFor(filter)}
      </div>
    )
  }

  return (
    <ul className="space-y-1.5 p-3">
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

function emptyMessageFor(filter: Filter): string {
  return filter === 'archived' ? 'No archived tapes yet.' : 'No tapes here. Paste a URL to add one.'
}
