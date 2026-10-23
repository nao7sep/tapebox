import { useMemo } from 'react'
import { useVirtualRows, type VirtualRow } from '@renderer/lib/useVirtualRows'
import { useBoxesStore } from '@renderer/store/boxes'
import { useSelectionStore } from '@renderer/store/selection'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { useTapeListboxKeyboard } from '@renderer/lib/useTapeListboxKeyboard'
import { TapeRow } from './TapeRow'
import { useI18n } from '@renderer/i18n/I18nContext'

/**
 * Read-only results for an archive search: matching tapes across all boxes,
 * ordered exactly like the box list reads (Unboxed first, then boxes in their
 * order) and grouped under a header band per box. The header — a flush, borderless
 * strip that sticks to the top while scrolling — does the job the old per-row
 * "in <box>" caption did, but as a real separator instead of a repeated label.
 * Not sortable: the order belongs to the boxes, not to this view.
 */
export function SearchResults() {
  const tapes = useVisibleTapes()
  const boxes = useBoxesStore((s) => s.boxes)
  const selectedId = useSelectionStore((s) => s.selectedId)
  // One listbox over the whole flat result set; the box headers are just group
  // separators, so Up/Down crosses them seamlessly.
  const kb = useTapeListboxKeyboard<HTMLDivElement>(tapes, selectedId)
  const t = useI18n()

  const { groups, rows } = useMemo(() => {
    const groups: { boxId: string | null; start: number; end: number }[] = []
    const rows: VirtualRow[] = []
    for (const tape of tapes) {
      let group = groups.at(-1)
      if (!group || group.boxId !== tape.boxId) {
        if (group) rows.at(-1)!.gap = 8
        group = { boxId: tape.boxId, start: rows.length, end: 0 }
        groups.push(group)
        rows.push({ id: `header:${tape.boxId ?? '__unboxed__'}`, estimate: 24, gap: 8 })
      }
      rows.push({ id: tape.id, estimate: 68, gap: 6 })
      group.end = rows.length
    }
    if (rows.length > 0) rows.at(-1)!.gap = 8
    return { groups, rows }
  }, [tapes])
  const byId = useMemo(() => new Map(tapes.map((tape) => [tape.id, tape])), [tapes])
  const virtual = useVirtualRows(rows, kb.ref, selectedId)
  const boxName = (boxId: string | null) =>
    (boxId === null ? null : boxes.find((g) => g.id === boxId)?.name) ?? t.t('boxes.unboxed')

  if (tapes.length === 0) return <div className="p-6 text-sm text-fg">{t.t('archive.noMatches')}</div>

  return (
    <div ref={kb.ref} {...kb.listboxProps} role="listbox" aria-label={t.t('archive.searchResults')} className="min-h-0 flex-1 overflow-y-auto pb-3 outline-none">
      {groups.map((group) => (
        <section
          key={group.boxId ?? '__unboxed__'}
          role="group"
          aria-label={boxName(group.boxId)}
          style={{ height: virtual.offsets[group.end]! - virtual.offsets[group.start]!, position: 'relative' }}
        >
          <div ref={virtual.rowRef(rows[group.start]!.id)} className="sticky top-0 z-10 truncate bg-sticky px-3 py-1 text-xs font-medium uppercase tracking-wide text-fg backdrop-blur-sm" data-literal>
            {boxName(group.boxId)}
          </div>
          <ul role="presentation" className="absolute inset-0">
            {virtual.mounted.filter((index) => index > group.start && index < group.end).map((index) => {
              const tape = byId.get(rows[index]!.id)!
              return (
                <li key={tape.id} role="presentation" ref={virtual.rowRef(tape.id)}
                  style={{ position: 'absolute', top: virtual.offsets[index]! - virtual.offsets[group.start]!, left: 12, right: 12 }}>
                  <TapeRow tape={tape} selected={tape.id === selectedId} id={kb.optionId(tape.id)} />
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
