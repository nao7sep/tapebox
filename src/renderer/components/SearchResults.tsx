import { useItemsStore } from '@renderer/store/items'
import { useGroupsStore } from '@renderer/store/groups'
import { useSelectionStore } from '@renderer/store/selection'
import { useVisibleItems } from '@renderer/lib/itemOrder'
import { UNGROUPED_LABEL } from '@shared/archive-names'
import { ItemRow } from './ItemRow'

/**
 * Read-only results for an archive search: matching tapes across all boxes (the
 * query lives in the archive store; useVisibleItems already filters to it). Each
 * row notes which box the tape is in so it can be located. Not sortable — order
 * is by recency, not a box order.
 */
export function SearchResults() {
  const tapes = useVisibleItems()
  const groups = useGroupsStore((s) => s.groups)
  const progress = useItemsStore((s) => s.progress)
  const selectedId = useSelectionStore((s) => s.selectedId)
  const select = useSelectionStore((s) => s.select)

  if (tapes.length === 0) {
    return <div className="p-6 text-sm text-zinc-300">No archived tapes match.</div>
  }

  const boxName = (groupId: string | null) =>
    groupId === null ? UNGROUPED_LABEL : groups.find((g) => g.id === groupId)?.name ?? UNGROUPED_LABEL

  return (
    <ul className="space-y-1.5 p-3">
      {tapes.map((item) => (
        <li key={item.id}>
          <ItemRow
            item={item}
            progress={progress[item.id]}
            selected={item.id === selectedId}
            onSelect={() => select(item.id)}
          />
          <div className="mt-0.5 pl-3 text-xs text-zinc-400">in {boxName(item.groupId)}</div>
        </li>
      ))}
    </ul>
  )
}
