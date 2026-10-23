import { useTapeDragPreview, useTapeDragSourceId } from '@renderer/lib/dnd'
import { useVirtualRows } from '@renderer/lib/useVirtualRows'
import { useMemo } from 'react'
import { useSelectionStore } from '@renderer/store/selection'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { useTapeListboxKeyboard } from '@renderer/lib/useTapeListboxKeyboard'
import { TapeRow } from './TapeRow'
import { SortableTape } from './SortableTape'
import { InlineError } from './ui'
import { useI18n } from '@renderer/i18n/I18nContext'
import type { Message } from '@shared/i18n/translate'

/**
 * The selected box's tapes, in manual order, as a sortable list. Reorder within
 * the box (drag a tape over another) and move between boxes (drag a tape onto a
 * box row) are both handled by the parent provider's completion mapping. Rows reuse the
 * shared TapeRow; the sortable wrapper is shared with the inbox.
 */
export function ArchiveTapeList({
  onReorder,
  orderError,
  onDismissOrderError,
}: {
  onReorder: (activeId: string, offset: -1 | 1) => void
  orderError: Message | null
  onDismissOrderError: () => void
}) {
  const original = useVisibleTapes()
  const tapes = useTapeDragPreview(original)
  const draggedId = useTapeDragSourceId()
  const originalIndices = useMemo(() => new Map(original.map((tape, index) => [tape.id, index])), [original])
  const selectedId = useSelectionStore((s) => s.selectedId)
  const kb = useTapeListboxKeyboard<HTMLUListElement>(tapes, selectedId, onReorder)
  const t = useI18n()
  const virtualRows = useMemo(() => tapes.map((tape, index) => ({ id: tape.id, estimate: 68, gap: index === tapes.length - 1 ? 0 : 6 })), [tapes])
  const virtual = useVirtualRows(virtualRows, kb.ref, selectedId, 12, draggedId)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {orderError && (
        <InlineError className="m-3 mb-0 shrink-0" onDismiss={onDismissOrderError} closeLabel={t.t('archive.closeTapeOrderResult')}>
          {t.text(orderError)}
        </InlineError>
      )}
      {tapes.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-6 text-sm text-fg">{t.t('archive.boxEmpty')}</div>
      ) : (
        <ul
          ref={kb.ref}
          {...kb.listboxProps}
          role="listbox"
          aria-label={t.t('archive.boxTapes')}
          className="relative min-h-0 flex-1 overflow-y-auto outline-none"
        >
          <li role="presentation" style={{ height: virtual.total, position: 'relative' }}>
            <ul role="presentation">
              {virtual.mounted.map((index) => {
                const tape = tapes[index]!
                return (
                  <SortableTape
                    key={tape.id}
                    id={tape.id}
                    index={originalIndices.get(tape.id)!}
                    style={{ position: 'absolute', top: virtual.offsets[index], left: 12, right: 12 }}
                    measureRef={virtual.rowRef(tape.id)}
                    onDragSource={virtual.onDragSource}
                  >
                    <TapeRow tape={tape} selected={tape.id === selectedId} id={kb.optionId(tape.id)} />
                  </SortableTape>
                )
              })}
            </ul>
          </li>
        </ul>
      )}
    </div>
  )
}
