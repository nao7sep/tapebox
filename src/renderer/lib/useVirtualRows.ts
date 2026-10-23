import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'

export type VirtualRow = { id: string; estimate: number; gap?: number }
const OVERSCAN = 5

/** First row whose lower edge reaches the requested offset. */
export function rowAtOffset(offsets: readonly number[], offset: number): number {
  let low = 0
  let high = Math.max(0, offsets.length - 1)
  while (low < high) {
    const mid = (low + high) >>> 1
    if (offsets[mid + 1]! <= offset) low = mid + 1
    else high = mid
  }
  return low
}

/** Variable-height rows keep one measurement per stable identity. Scroll only
 * searches the prefix offsets; measurement changes are coalesced into one frame. */
export function useVirtualRows(
  rows: readonly VirtualRow[],
  viewportRef: RefObject<HTMLElement | null>,
  selectedId: string | null,
  padding = 0,
  activeDragId: string | null = null,
) {
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map())
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const nodes = useRef(new Map<string, HTMLElement>())
  const refs = useRef(new Map<string, (node: HTMLElement | null) => void>())
  const observer = useRef<ResizeObserver | null>(null)
  const offsets = useMemo(() => {
    const result = [padding]
    for (const row of rows) result.push(result.at(-1)! + (heights.get(row.id) ?? row.estimate) + (row.gap ?? 0))
    return result
  }, [rows, heights, padding])
  const indices = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows])
  const selectedIndex = selectedId === null ? undefined : indices.get(selectedId)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const sync = () => setViewport({ top: viewport.scrollTop, height: viewport.clientHeight })
    viewport.addEventListener('scroll', sync, { passive: true })
    const resize = new ResizeObserver(sync)
    resize.observe(viewport)
    sync()
    return () => { viewport.removeEventListener('scroll', sync); resize.disconnect() }
  }, [viewportRef, rows.length > 0])

  useLayoutEffect(() => {
    const pending = new Map<string, number>()
    let frame: number | undefined
    const resize = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.virtualId
        if (!id) continue
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height
        if (height > 0) pending.set(id, height)
      }
      if (frame === undefined && pending.size > 0) frame = requestAnimationFrame(() => {
        frame = undefined
        const updates = new Map(pending); pending.clear()
        setHeights((previous) => {
          if (![...updates].some(([id, height]) => previous.get(id) !== height)) return previous
          const next = new Map(previous)
          for (const [id, height] of updates) next.set(id, height)
          return next
        })
      })
    })
    observer.current = resize
    for (const node of nodes.current.values()) resize.observe(node)
    return () => { observer.current = null; resize.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [])

  useLayoutEffect(() => {
    const currentIds = indices
    for (const id of refs.current.keys()) if (!currentIds.has(id)) refs.current.delete(id)
    setHeights((previous) => {
      if ([...previous.keys()].every((id) => currentIds.has(id))) return previous
      return new Map([...previous].filter(([id]) => currentIds.has(id)))
    })
  }, [indices])

  // Layout precedes the keyboard hook's scrollIntoView effect. The selected row
  // is pinned below, so aria-activedescendant always resolves during this move.
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el || selectedIndex === undefined) return
    const top = offsets[selectedIndex]!
    const bottom = offsets[selectedIndex + 1]!
    if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, bottom - el.clientHeight)
    setViewport({ top: el.scrollTop, height: el.clientHeight })
  }, [selectedId, selectedIndex, viewportRef])

  const first = Math.max(0, rowAtOffset(offsets, viewport.top) - OVERSCAN)
  const last = Math.min(rows.length, rowAtOffset(offsets, viewport.top + viewport.height) + OVERSCAN + 1)
  const mounted = new Set<number>()
  for (let index = first; index < last; index++) mounted.add(index)
  if (selectedIndex !== undefined) mounted.add(selectedIndex)
  const pinnedDragId = activeDragId ?? draggedId
  const draggedIndex = pinnedDragId === null ? undefined : indices.get(pinnedDragId)
  if (draggedIndex !== undefined) mounted.add(draggedIndex)

  const rowRef = useCallback((id: string) => {
    let ref = refs.current.get(id)
    if (!ref) {
      ref = (node) => {
        const previous = nodes.current.get(id)
        if (previous) observer.current?.unobserve(previous)
        if (node) {
          node.dataset.virtualId = id
          nodes.current.set(id, node)
          observer.current?.observe(node)
        } else nodes.current.delete(id)
      }
      refs.current.set(id, ref)
    }
    return ref
  }, [])
  const onDragSource = useCallback((id: string, active: boolean) => {
    setDraggedId((previous) => active ? id : previous === id ? null : previous)
  }, [])
  return { mounted: [...mounted].sort((a, b) => a - b), offsets, total: offsets.at(-1)! + padding, rowRef, onDragSource }
}
