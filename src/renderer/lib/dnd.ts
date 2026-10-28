import { createElement, type ReactElement, type ReactNode } from 'react'
import { DragDropProvider, type DragEndEvent } from '@dnd-kit/react'
import {
  Accessibility,
  PointerActivationConstraints,
  PointerSensor,
} from '@dnd-kit/dom'
import { isSortable, isSortableOperation } from '@dnd-kit/react/sortable'

export const TAPE_DRAG_TYPE = 'tape'
export const BOX_DRAG_TYPE = 'box'
export const BOX_TARGET_TYPE = 'box-target'
export const TAPE_SORT_GROUP = 'tapes'
export const BOX_SORT_GROUP = 'boxes'

// Tape and box rows are also click-to-select, rename, and menu surfaces. Require
// deliberate movement before the pointer sensor takes ownership of the press.
const LISTBOX_POINTER_SENSOR = PointerSensor.configure({
  activationConstraints: [
    new PointerActivationConstraints.Distance({ value: 5 }),
  ],
})

/**
 * The listboxes own one roving tab stop and Cmd/Ctrl+Shift+Arrow reorder through
 * the same durable operations as pointer drag. Replacing the default sensors
 * removes dnd-kit's competing keyboard path; filtering Accessibility prevents
 * it from projecting button/tabindex semantics onto the listbox rows.
 */
export function ListboxDragProvider({
  children,
  onDragEnd,
}: {
  children: ReactNode
  onDragEnd: (event: DragEndEvent) => void
}): ReactElement {
  return createElement(
    DragDropProvider,
    {
      sensors: [LISTBOX_POINTER_SENSOR],
      plugins: (defaults) => defaults.filter((plugin) => plugin !== Accessibility),
      onDragEnd,
    },
    children,
  )
}

export type TapeListDropPlan = {
  tapeId: string
  fromIndex: number
  toIndex: number
}

/** Map a completed library sort into TapeBox's one durable inbox operation. */
export function planTapeListDrop(event: DragEndEvent): TapeListDropPlan | null {
  const { operation } = event
  if (event.canceled || !isSortableOperation(operation)) return null
  const { source, target } = operation
  if (!source || !target) return null
  if (source.type !== TAPE_DRAG_TYPE || target.type !== TAPE_DRAG_TYPE) return null
  if (source.initialIndex === source.index) return null
  return {
    tapeId: String(source.id),
    fromIndex: source.initialIndex,
    toIndex: source.index,
  }
}

export type ArchiveDropPlan =
  | { kind: 'reorder-box'; boxId: string; fromIndex: number; toIndex: number }
  | { kind: 'reorder-tape'; tapeId: string; fromIndex: number; toIndex: number }
  | { kind: 'move-tape'; tapeId: string; boxId: string | null }

/** Map one archive release to reorder-within-list or move-to-semantic-box. */
export function planArchiveDrop(event: DragEndEvent): ArchiveDropPlan | null {
  if (event.canceled) return null
  const { source, target } = event.operation
  if (!source || !target || !isSortable(source)) return null

  if (source.type === BOX_DRAG_TYPE) {
    if (!isSortableOperation(event.operation) || target.type !== BOX_DRAG_TYPE) return null
    if (source.initialIndex === source.index) return null
    return {
      kind: 'reorder-box',
      boxId: String(source.id),
      fromIndex: source.initialIndex,
      toIndex: source.index,
    }
  }

  if (source.type !== TAPE_DRAG_TYPE) return null
  if (target.type === BOX_TARGET_TYPE) {
    const boxId = target.data.boxId
    if (boxId !== null && typeof boxId !== 'string') return null
    return { kind: 'move-tape', tapeId: String(source.id), boxId }
  }
  if (!isSortableOperation(event.operation) || target.type !== TAPE_DRAG_TYPE) return null
  if (source.initialIndex === source.index) return null
  return {
    kind: 'reorder-tape',
    tapeId: String(source.id),
    fromIndex: source.initialIndex,
    toIndex: source.index,
  }
}
