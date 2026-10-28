import { useEffect, useRef, useState, type RefObject } from 'react'
import { ipcInvoke } from '@renderer/ipc/client'
import type { RecordsQuery, RecordSummary } from '@shared/records'
import { cursorAfter, nearEnd } from './record-format'

type Filters = Omit<RecordsQuery, 'after'>
type State = {
  status: 'loading' | 'failed' | 'ready'
  records: RecordSummary[]
  more: boolean
  loadingMore: boolean
  moreFailed: boolean
  failed: boolean
}
const initial: State = { status: 'loading', records: [], more: false, loadingMore: false, moreFailed: false, failed: false }

/** The Records list: the newest page, then each next page appended as the end
 * of the list comes near. A page applies only while the filters and refresh it
 * was read for are still the newest. */
export function useRecordPages(filters: Filters, viewportRef: RefObject<HTMLElement | null>, onFailure: (error: unknown) => void) {
  const [state, setState] = useState<State>(initial)
  const current = useRef(state)
  const generation = useRef(0)
  const query = useRef(filters)
  const failure = useRef(onFailure)
  failure.current = onFailure

  function publish(next: State) { current.current = next; setState(next) }

  function loadMore() {
    const shown = current.current
    if (shown.status !== 'ready' || !shown.more || shown.loadingMore) return
    const epoch = generation.current
    publish({ ...shown, loadingMore: true, moreFailed: false })
    ipcInvoke('records:page', { ...query.current, after: cursorAfter(shown.records) }).then((page) => {
      if (epoch !== generation.current) return
      const old = current.current
      publish({ ...old, records: [...old.records, ...page.records], more: page.more && page.records.length > 0, loadingMore: false, failed: false })
    }, (error: unknown) => {
      if (epoch !== generation.current) return
      publish({ ...current.current, loadingMore: false, moreFailed: true, failed: true })
      failure.current(error)
    })
  }

  /** Read the newest page. A live refresh keeps the shown rows until it arrives
   * and then replaces them, since new records move every page boundary. */
  function readNewest(keepShown: boolean): Promise<void> {
    const epoch = ++generation.current
    publish(keepShown ? { ...current.current, loadingMore: false } : initial)
    return ipcInvoke('records:page', { ...query.current, after: null }).then((page) => {
      if (epoch !== generation.current) return
      publish({ status: 'ready', records: page.records, more: page.more && page.records.length > 0, loadingMore: false, moreFailed: false, failed: false })
    }, (error: unknown) => {
      if (epoch !== generation.current) return
      publish({ ...current.current, status: current.current.status === 'ready' ? 'ready' : 'failed', failed: true })
      failure.current(error)
    })
  }

  useEffect(() => {
    query.current = filters
    if (viewportRef.current) viewportRef.current.scrollTop = 0
    void readNewest(false)
    return () => { generation.current += 1 }
  }, [filters])

  // A page that leaves the list short of the end reads the next one; a failed
  // page waits until the reader reaches the end again.
  useEffect(() => {
    const scroll = viewportRef.current
    if (state.status !== 'ready' || state.loadingMore || state.moreFailed || scroll === null) return
    if (nearEnd(scroll)) loadMore()
  }, [state])

  function onScroll() {
    const scroll = viewportRef.current
    if (scroll && nearEnd(scroll)) loadMore()
  }

  return { ...state, onScroll, loadMore, refresh: () => readNewest(true) }
}
