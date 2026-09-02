import { useCallback, useEffect, useRef, useState } from 'react'
import { copyTapeSourceUrl } from '@renderer/lib/tapeActions'

const COPIED_RESET_MS = 1500

/** Own the transient Copy URL acknowledgement for the currently selected tape. */
export function useCopyTapeSourceUrl(tapeId: string, sourceUrl: string): {
  copied: boolean
  copy: () => Promise<void>
} {
  const [copied, setCopied] = useState(false)
  const currentTapeIdRef = useRef(tapeId)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  currentTapeIdRef.current = tapeId

  useEffect(() => {
    setCopied(false)
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = null
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
  }, [tapeId])

  const copy = useCallback(async (): Promise<void> => {
    const requestedTapeId = tapeId
    const succeeded = await copyTapeSourceUrl(requestedTapeId, sourceUrl)
    if (!succeeded || currentTapeIdRef.current !== requestedTapeId) return
    setCopied(true)
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null
      if (currentTapeIdRef.current === requestedTapeId) setCopied(false)
    }, COPIED_RESET_MS)
  }, [sourceUrl, tapeId])

  return { copied, copy }
}
