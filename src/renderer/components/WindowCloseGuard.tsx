import { useLayoutEffect, useState } from 'react'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import { setWindowClosePending, useWindowCloseGuard, windowCloseState } from '@renderer/lib/windowClose'
import { useBoxesStore } from '@renderer/store/boxes'
import { DiscardChangesPrompt } from './DiscardChangesPrompt'

/** macOS closes the workspace without quitting. The native close request
 * keeps its draft owners alive until discard is explicit. Ordinary Quit is
 * prevented by main's quit owner and ends through app.exit, which bypasses
 * window close; OS session end follows that same non-prompting exit boundary. */
export function WindowCloseGuard() {
  const [asking, setAsking] = useState(false)
  // The box editor may be unmounted while Inbox is visible. Its session draft
  // and pending save still participate in native-close consent.
  useWindowCloseGuard(() => {
    const { boxes, editingId, draftName, pendingRenames } = useBoxesStore.getState()
    return {
      dirty: editingId !== null && draftName !== boxes.find((box) => box.id === editingId)?.name,
      busy: pendingRenames > 0,
    }
  })

  function question(value: boolean) {
    setWindowClosePending(value)
    setAsking(value)
  }

  function close() {
    if (windowCloseState().busy) return
    void ipcInvoke('app:closeWindow').catch((error) => {
      question(false)
      log.warn('window close failed', { error: describeError(error) })
    })
  }

  useLayoutEffect(() => {
    const stop = ipcOn('app:windowCloseRequested', () => {
      const state = windowCloseState()
      if (state.busy) return
      if (state.dirty) question(true)
      else close()
    })
    return () => {
      stop()
      setWindowClosePending(false)
    }
  }, [])

  if (!asking) return null
  return <DiscardChangesPrompt
    onKeepEditing={() => question(false)}
    onDiscard={close}
  />
}
