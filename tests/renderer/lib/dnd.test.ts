// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Accessibility } from '@dnd-kit/dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const dnd = vi.hoisted(() => ({
  provider: null as Record<string, any> | null,
  sortables: [] as Record<string, unknown>[],
  droppables: [] as Record<string, unknown>[],
}))
const dom = vi.hoisted(() => {
  class Accessibility {}
  class Distance {
    constructor(readonly options: { value: number }) {}
  }
  class PointerSensor {
    static configure(options: unknown) {
      return { plugin: PointerSensor, options }
    }
  }
  return {
    Accessibility,
    PointerSensor,
    PointerActivationConstraints: { Distance },
  }
})

vi.mock('@dnd-kit/dom', () => dom)

vi.mock('@dnd-kit/react', async () => {
  const ReactModule = await import('react')
  return {
    DragDropProvider: ({ children, ...props }: any) => {
      dnd.provider = props
      return ReactModule.createElement(ReactModule.Fragment, null, children)
    },
    useDroppable: (input: Record<string, unknown>) => {
      dnd.droppables.push(input)
      return { ref: () => undefined, isDropTarget: false }
    },
  }
})

vi.mock('@dnd-kit/react/sortable', () => ({
  isSortable: (entity: { sortable?: boolean } | null) => entity?.sortable === true,
  isSortableOperation: (operation: {
    source?: { sortable?: boolean } | null
    target?: { sortable?: boolean } | null
  }) => operation.source?.sortable === true && operation.target?.sortable === true,
  useSortable: (input: Record<string, unknown>) => {
    dnd.sortables.push(input)
    return { ref: () => undefined }
  },
}))

import {
  BOX_DRAG_TYPE,
  BOX_SORT_GROUP,
  BOX_TARGET_TYPE,
  ListboxDragProvider,
  TAPE_DRAG_TYPE,
  TAPE_SORT_GROUP,
  planArchiveDrop,
  planTapeListDrop,
} from '@renderer/lib/dnd'
import { SortableTape } from '@renderer/components/SortableTape'
import { BoxList, UNBOXED_DROP_ID } from '@renderer/components/BoxList'
import { useBoxesStore } from '@renderer/store/boxes'
import { useTapesStore } from '@renderer/store/tapes'
import { useArchiveStore } from '@renderer/store/archive'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  dnd.provider = null
  dnd.sortables = []
  dnd.droppables = []
  useBoxesStore.setState({ boxes: [] })
  useTapesStore.setState({ tapes: [], progress: {} })
  useArchiveStore.setState({ selectedBoxId: null, query: '' })
  document.body.innerHTML = ''
})

describe('listbox drag configuration', () => {
  it('retains the row-interaction threshold without adding a second keyboard model', () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(
      createElement(ListboxDragProvider, { onDragEnd: vi.fn(), children: 'Rows' }),
    ))

    const provider = dnd.provider as any
    expect(provider.sensors).toHaveLength(1)
    expect(provider.sensors[0].options.activationConstraints[0].options.value).toBe(5)

    const retainedPlugin = {}
    expect(provider.plugins([Accessibility, retainedPlugin])).toEqual([retainedPlugin])
  })

  it('registers tape rows as stable pointer-sortable listbox members', () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(createElement(
      SortableTape,
      { id: 'tape-a', index: 2, children: createElement('div', { role: 'option' }, 'Tape') },
    )))

    expect(dnd.sortables).toEqual([{
      id: 'tape-a',
      index: 2,
      type: TAPE_DRAG_TYPE,
      accept: TAPE_DRAG_TYPE,
      group: TAPE_SORT_GROUP,
      data: { type: 'tape' },
    }])
    expect(host.firstElementChild?.getAttribute('role')).toBe('presentation')
    expect(host.querySelector('[role="option"]')?.hasAttribute('tabindex')).toBe(false)
  })

  it('registers box sorting separately from tape-delivery receivers', () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    useBoxesStore.setState({ boxes: [{ id: 'box-a', name: 'A', order: 0 }] })

    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(createElement(BoxList, {
      onReorder: vi.fn(),
      orderError: null,
      onDismissOrderError: vi.fn(),
    })))

    expect(dnd.sortables).toEqual([{
      id: 'box-a',
      index: 0,
      type: BOX_DRAG_TYPE,
      accept: BOX_DRAG_TYPE,
      group: BOX_SORT_GROUP,
      data: { type: BOX_DRAG_TYPE },
    }])
    expect(dnd.droppables).toEqual([
      {
        id: UNBOXED_DROP_ID,
        type: BOX_TARGET_TYPE,
        accept: TAPE_DRAG_TYPE,
        data: { type: BOX_TARGET_TYPE, boxId: null },
      },
      {
        id: 'box-target:box-a',
        type: BOX_TARGET_TYPE,
        accept: TAPE_DRAG_TYPE,
        data: { type: BOX_TARGET_TYPE, boxId: 'box-a' },
      },
    ])
    expect(host.querySelectorAll('[role="listbox"][tabindex="0"]')).toHaveLength(1)
    expect(host.querySelectorAll('[role="option"][tabindex]')).toHaveLength(0)
  })

  it('keeps a reorder failure inside the owning box list and dismisses it there', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const dismiss = vi.fn()
    root = createRoot(host)
    act(() => root!.render(createElement(BoxList, {
      onReorder: vi.fn(),
      orderError: 'Could not save box order: disk full',
      onDismissOrderError: dismiss,
    })))

    const list = host.querySelector<HTMLElement>('[role="listbox"][aria-label="Boxes"]')!
    const alert = host.querySelector<HTMLElement>('[role="alert"]')!
    expect(list.parentElement?.contains(alert)).toBe(true)
    expect(alert.textContent).toContain('Could not save box order: disk full')
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Close box order result"]')!.click())
    expect(dismiss).toHaveBeenCalledOnce()
  })
})

function sortable(id: string, type: string, initialIndex: number, index: number) {
  return { id, type, initialIndex, index, data: { type }, sortable: true }
}

function dropEvent(
  source: Record<string, unknown> | null,
  target: Record<string, unknown> | null,
  canceled = false,
) {
  return { canceled, operation: { source, target } } as never
}

describe('current dnd-kit completion mapping', () => {
  it('maps inbox sorting and rejects cancellation and no-ops', () => {
    const source = sortable('tape-a', TAPE_DRAG_TYPE, 0, 2)
    const target = sortable('tape-c', TAPE_DRAG_TYPE, 2, 2)

    expect(planTapeListDrop(dropEvent(source, target))).toEqual({
      tapeId: 'tape-a',
      fromIndex: 0,
      toIndex: 2,
    })
    expect(planTapeListDrop(dropEvent(source, target, true))).toBeNull()
    expect(planTapeListDrop(dropEvent(sortable('tape-a', TAPE_DRAG_TYPE, 1, 1), target))).toBeNull()
    expect(planTapeListDrop(dropEvent(source, null))).toBeNull()
  })

  it('keeps archive list sorting distinct from semantic box delivery', () => {
    expect(planArchiveDrop(dropEvent(
      sortable('box-a', BOX_DRAG_TYPE, 0, 1),
      sortable('box-b', BOX_DRAG_TYPE, 1, 1),
    ))).toEqual({
      kind: 'reorder-box',
      boxId: 'box-a',
      fromIndex: 0,
      toIndex: 1,
    })

    expect(planArchiveDrop(dropEvent(
      sortable('tape-a', TAPE_DRAG_TYPE, 2, 0),
      sortable('tape-b', TAPE_DRAG_TYPE, 0, 0),
    ))).toEqual({
      kind: 'reorder-tape',
      tapeId: 'tape-a',
      fromIndex: 2,
      toIndex: 0,
    })

    expect(planArchiveDrop(dropEvent(
      sortable('tape-a', TAPE_DRAG_TYPE, 0, 0),
      {
        id: 'box-target:box-b',
        type: BOX_TARGET_TYPE,
        data: { type: BOX_TARGET_TYPE, boxId: 'box-b' },
      },
    ))).toEqual({ kind: 'move-tape', tapeId: 'tape-a', boxId: 'box-b' })

    expect(planArchiveDrop(dropEvent(
      sortable('tape-a', TAPE_DRAG_TYPE, 0, 0),
      {
        id: '__unboxed__',
        type: BOX_TARGET_TYPE,
        data: { type: BOX_TARGET_TYPE, boxId: null },
      },
    ))).toEqual({ kind: 'move-tape', tapeId: 'tape-a', boxId: null })

    expect(planArchiveDrop(dropEvent(
      sortable('tape-a', TAPE_DRAG_TYPE, 0, 1),
      sortable('tape-b', TAPE_DRAG_TYPE, 1, 1),
      true,
    ))).toBeNull()
  })
})
