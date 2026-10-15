import { useLayoutEffect, useRef, useState } from 'react'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import { setWindowClosePending, useWindowCloseGuard, windowCloseState } from '@renderer/lib/windowClose'
import { useBoxesStore } from '@renderer/store/boxes'
import { DiscardChangesPrompt } from './DiscardChangesPrompt'

/** Every quit, including closing this window, asks here before it discards the
 * window's drafts (unsaved-edits-conventions): Settings, Rename, Export and a box
 * name being edited. Main asks the question itself while the window is
 * minimized, so this only reports the drafts then. OS session end never asks. */
export function WindowCloseGuard() {
  const [asking, setAsking] = useState(false)
  const request = useRef<number | null>(null)
  // The box editor may be unmounted while Inbox is visible. Its session draft
  // still counts.
  useWindowCloseGuard(() => {
    const { boxes, editingId, draftName } = useBoxesStore.getState()
    return { dirty: editingId !== null && draftName !== boxes.find((box) => box.id === editingId)?.name }
  })

  function answer(requestId: number, dirty: boolean, discard: boolean) {
    void ipcInvoke('app:quitDraftsAnswer', { requestId, dirty, discard }).catch((error) => {
      log.warn('quit draft answer failed', { error: describeError(error) })
    })
  }

  function settle(discard: boolean) {
    const requestId = request.current
    request.current = null
    setWindowClosePending(false)
    setAsking(false)
    if (requestId !== null) answer(requestId, true, discard)
  }

  useLayoutEffect(() => {
    const stop = ipcOn('app:quitDraftsRequested', ({ requestId, ask }) => {
      if (!windowCloseState().dirty) return answer(requestId, false, true)
      if (!ask) return answer(requestId, true, false)
      request.current = requestId
      setWindowClosePending(true)
      setAsking(true)
    })
    return () => {
      stop()
      setWindowClosePending(false)
    }
  }, [])

  if (!asking) return null
  return <DiscardChangesPrompt
    onKeepEditing={() => settle(false)}
    onDiscard={() => settle(true)}
  />
}
