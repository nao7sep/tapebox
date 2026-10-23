// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class {
    observe() {} unobserve() {} disconnect() {}
  } })
  globalThis.ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  }
})
const bridge = vi.hoisted(() => ({ props: null as Record<string, any> | null }))
vi.mock('@dnd-kit/react', async (original) => {
  const actual = await original<typeof import('@dnd-kit/react')>()
  const React = await import('react')
  return {
    ...actual,
    DragDropProvider: ({ children, ...props }: { children: ReactNode }) => {
      bridge.props = props
      return React.createElement(React.Fragment, null, children)
    },
  }
})

import { DragDropManager } from '@dnd-kit/dom'
import { OptimisticSortingPlugin, Sortable } from '@dnd-kit/dom/sortable'
import { ListboxDragProvider, planTapeListDrop } from '@renderer/lib/dnd'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let manager: DragDropManager | undefined
const sortables: Sortable[] = []
afterEach(async () => {
  manager?.dragOperation.reset()
  for (const sortable of sortables.splice(0)) sortable.destroy()
  manager?.destroy()
  manager = undefined
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.innerHTML = ''
})

it('prevents the real optimistic plugin from compacting sparse tape indices or moving DOM', async () => {
  const host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  const finished = vi.fn()
  await act(async () => root!.render(createElement(ListboxDragProvider, { onDragEnd: finished, children: null })))
  manager = new DragDropManager({ plugins: [OptimisticSortingPlugin], sensors: [] })
  const container = document.createElement('div'); document.body.append(container)
  for (const [id, index] of [['source', 1], ['target', 1000]] as const) {
    const element = document.createElement('div'); element.id = id; container.append(element)
    const sortable = new Sortable({ id, index, element, group: 'tapes', type: 'tape', accept: 'tape', transition: null }, manager)
    sortable.register(); sortables.push(sortable)
  }
  const [source, target] = sortables
  const unsubscribe = manager.monitor.addEventListener('dragover', (event) => bridge.props!.onDragOver(event))
  await act(async () => { manager!.actions.start({ source: 'source', coordinates: { x: 0, y: 0 } }); await manager!.renderer.rendering })
  let prevented = false
  await act(async () => { prevented = await manager!.actions.setDropTarget('target') })
  expect(prevented).toBe(true)
  expect(source!.index).toBe(1)
  expect(target!.index).toBe(1000)
  expect([...container.children].map((el) => el.id)).toEqual(['source', 'target'])
  const ids = Array.from({ length: 1001 }, (_, index) => index === 1 ? 'source' : index === 1000 ? 'target' : `other-${index}`)
  expect(planTapeListDrop({ canceled: false, operation: manager.dragOperation.snapshot() } as never, ids)).toEqual({ tapeId: 'source', fromIndex: 1, toIndex: 1000 })
  // Moving the preview under the pointer can make the actual final collision
  // hit the source itself. The provider forwards its last preview target as a
  // separate argument, keeping the original library event intact.
  const end = manager.monitor.addEventListener('dragend', (event) => bridge.props!.onDragEnd(event))
  await act(async () => { await manager!.actions.setDropTarget('source') })
  await act(async () => manager!.actions.stop())
  expect(finished).toHaveBeenCalledOnce()
  const [event, previewTargetId] = finished.mock.calls[0]!
  expect(event.operation.target.id).toBe('source')
  expect(previewTargetId).toBe('target')
  expect(planTapeListDrop(event, ids, previewTargetId)).toEqual({ tapeId: 'source', fromIndex: 1, toIndex: 1000 })
  end()
  unsubscribe()
})

it('leaves the real box optimistic sorting plugin active', async () => {
  const host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(ListboxDragProvider, { onDragEnd: () => {}, children: null })))
  manager = new DragDropManager({ plugins: [OptimisticSortingPlugin], sensors: [] })
  const container = document.createElement('div'); document.body.append(container)
  for (const [id, index] of [['box-a', 0], ['box-b', 1]] as const) {
    const element = document.createElement('div'); element.id = id; container.append(element)
    const sortable = new Sortable({ id, index, element, group: 'boxes', type: 'box', accept: 'box', transition: null }, manager)
    sortable.register(); sortables.push(sortable)
  }
  const unsubscribe = manager.monitor.addEventListener('dragover', (event) => bridge.props!.onDragOver(event))
  await act(async () => { manager!.actions.start({ source: 'box-a', coordinates: { x: 0, y: 0 } }); await manager!.renderer.rendering })
  await act(async () => { await manager!.actions.setDropTarget('box-b') })
  expect(sortables[0]!.index).toBe(1)
  expect(sortables[1]!.index).toBe(0)
  expect([...container.children].map((el) => el.id)).toEqual(['box-b', 'box-a'])
  unsubscribe()
})
