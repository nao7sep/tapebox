import { createContext, useContext, useEffect, useState } from 'react'
import type { Tape } from '@shared/domain'
import type { SidecarRaw } from '@shared/ipc-contract'
import type { Message } from '@shared/i18n/translate'
import { IpcCallError } from '@shared/ipc-reply'
import { describeError } from '@shared/error'
import { ipcInvoke } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { useMediaStore } from '@renderer/store/media'

type PreviewState =
  | { status: 'loading'; data: null }
  | { status: 'loaded'; data: SidecarRaw }
  | { status: 'failed'; data: null; userMessage: Message | null }
export type SidecarPreview = PreviewState & { key: string; retry: () => void }
export const SidecarPreviewContext = createContext<SidecarPreview | null>(null)

/** The pane owns its preview; tools inherit it. Standalone tools own their read.
 * A metadata revision or collection replacement invalidates the complete result,
 * including errors, without keeping a library-sized cache of sidecar objects. */
export function useSidecarPreview(tape: Tape): SidecarPreview {
  const collection = useMediaStore((state) => state.collectionRevision)
  const key = JSON.stringify([collection, tape.id, tape.state, tape.sidecarFilename, tape.probedAtUtc])
  const inherited = useContext(SidecarPreviewContext)
  const shared = inherited?.key === key ? inherited : null
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<PreviewState & { key: string }>({ key, status: 'loading', data: null })
  useEffect(() => {
    if (shared) return
    if (tape.state !== 'downloaded') {
      setResult({ key, status: 'loaded', data: {} })
      return
    }
    let active = true
    setResult({ key, status: 'loading', data: null })
    ipcInvoke('library:getSidecar', { tapeId: tape.id }).then((data) => {
      if (active) setResult({ key, status: 'loaded', data })
    }).catch((error: unknown) => {
      if (!active) return
      if (!(error instanceof IpcCallError)) log.error('sidecar preview load failed', { error: describeError(error) })
      setResult({ key, status: 'failed', data: null, userMessage: error instanceof IpcCallError ? error.userMessage : null })
    })
    return () => { active = false }
  }, [key, attempt, shared !== null])
  if (shared) return shared
  return {
    ...(result.key === key ? result : { key, status: 'loading' as const, data: null }),
    retry: () => setAttempt((value) => value + 1),
  }
}
