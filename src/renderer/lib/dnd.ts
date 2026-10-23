import type { Tape } from '@shared/domain'
import { moveArrayItem } from './optimisticOrder'
import { createContext, createElement, useContext, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { DragDropProvider, type DragEndEvent, type DragOverEvent } from '@dnd-kit/react'
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
type TapePreview = { draggedId: string; targetId: string | null } | null
const TapePreviewContext = createContext<TapePreview>(null)

/** Keep hover order separate from the catalog. Full-list identities make sparse
 * virtual rows behave like a fully mounted list. */
export function useTapeDragPreview(tapes: Tape[]): Tape[] {
  const preview = useContext(TapePreviewContext)
  return useMemo(() => {
    if (!preview?.targetId) return tapes
    const from = tapes.findIndex((tape) => tape.id === preview.draggedId)
    const to = tapes.findIndex((tape) => tape.id === preview.targetId)
    return from < 0 || to < 0 || from === to ? tapes : moveArrayItem(tapes, from, to)
  }, [tapes, preview])
}

export function useTapeDragSourceId(): string | null {
  return useContext(TapePreviewContext)?.draggedId ?? null
}

export function ListboxDragProvider({
  children,
  onDragEnd,
}: {
  children: ReactNode
  onDragEnd: (event: DragEndEvent, previewTargetId?: string) => void
}): ReactElement {
  const [preview, setPreview] = useState<TapePreview>(null)
  const previewRef = useRef<TapePreview>(null)
  function updatePreview(value: TapePreview) {
    previewRef.current = value
    setPreview(value)
  }
  function onDragOver(event: DragOverEvent) {
    const { source, target } = event.operation
    if (source?.type !== TAPE_DRAG_TYPE) return
    if (target?.type !== TAPE_DRAG_TYPE) { updatePreview({ draggedId: String(source.id), targetId: null }); return }
    // The library's deferred optimistic sorter only knows mounted siblings and
    // reindexes them densely. Prevent it from moving DOM or rewriting indices;
    // app preview uses full-list identities while feedback and auto-scroll stay on.
    event.preventDefault()
    const draggedId = String(source.id)
    const targetId = String(target.id)
    if (draggedId !== targetId) updatePreview({ draggedId, targetId })
  }
  return createElement(
    DragDropProvider,
    {
      sensors: [LISTBOX_POINTER_SENSOR],
      plugins: (defaults) => defaults.filter((plugin) => plugin !== Accessibility),
      onDragStart: ({ operation }) => {
        const source = operation.source
        updatePreview(source?.type === TAPE_DRAG_TYPE ? { draggedId: String(source.id), targetId: null } : null)
      },
      onDragOver,
      onDragEnd: (event) => {
        const { source, target } = event.operation
        const last = previewRef.current
        // Preview may move the dragged row under the pointer. Only that self-hit
        // reuses the prior target; outside/null targets and box delivery keep
        // their ordinary completion meaning.
        const previewTargetId = !event.canceled && source?.type === TAPE_DRAG_TYPE &&
          target?.type === TAPE_DRAG_TYPE && target.id === source.id && last?.draggedId === String(source.id)
          ? last.targetId ?? undefined : undefined
        updatePreview(null)
        onDragEnd(event, previewTargetId)
      },
    },
    createElement(TapePreviewContext.Provider, { value: preview }, children),
  )
}

export type TapeListDropPlan = {
  tapeId: string
  fromIndex: number
  toIndex: number
}

/** Map a completed library sort into TapeBox's one durable inbox operation. */
export function planTapeListDrop(event: DragEndEvent, orderedIds: readonly string[], previewTargetId?: string): TapeListDropPlan | null {
  const { source, target } = event.operation
  if (event.canceled || source?.type !== TAPE_DRAG_TYPE || target?.type !== TAPE_DRAG_TYPE) return null
  const fromIndex = orderedIds.indexOf(String(source.id))
  const targetId = target.id === source.id && previewTargetId ? previewTargetId : String(target.id)
  const toIndex = orderedIds.indexOf(targetId)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null
  return { tapeId: String(source.id), fromIndex, toIndex }
}

export type ArchiveDropPlan =
  | { kind: 'reorder-box'; boxId: string; fromIndex: number; toIndex: number }
  | { kind: 'reorder-tape'; tapeId: string; fromIndex: number; toIndex: number }
  | { kind: 'move-tape'; tapeId: string; boxId: string | null }

/** Map one archive release to reorder-within-list or move-to-semantic-box. */
export function planArchiveDrop(event: DragEndEvent, orderedTapeIds: readonly string[] = [], previewTargetId?: string): ArchiveDropPlan | null {
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
  const plan = planTapeListDrop(event, orderedTapeIds, previewTargetId)
  return plan ? { kind: 'reorder-tape', ...plan } : null
}
