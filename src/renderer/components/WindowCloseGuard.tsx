import { useLayoutEffect, useState } from 'react'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import { setWindowClosePending, windowCloseState } from '@renderer/lib/windowClose'
import { DiscardChangesPrompt } from './DiscardChangesPrompt'

/** macOS closes the workspace without quitting. The native close request
 * keeps its draft owners alive until discard is explicit. Ordinary Quit is
 * prevented by main's quit owner and ends through app.exit, which bypasses
 * window close; OS session end follows that same non-prompting exit boundary. */
export function WindowCloseGuard() {
  const [asking, setAsking] = useState(false)

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
