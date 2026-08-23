import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { pathForFile } from '@renderer/ipc/client'
import { useImportMedia } from '@renderer/lib/useImportMedia'

type Props = { children: ReactNode }
type SidecarDragOffer = 'rejected' | 'delivery-only' | 'accepted'

export function inspectSidecarDragOffer(
  dataTransfer: Pick<DataTransfer, 'types' | 'items'>,
): SidecarDragOffer {
  const hasFilesType = Array.from(dataTransfer.types).includes('Files')
  const items = Array.from(dataTransfer.items)
  if (!hasFilesType && !items.some((item) => item.kind === 'file')) return 'rejected'
  if (items.length === 0) return 'delivery-only'

  let protectedFile = false
  let sawFile = false
  for (const item of items) {
    if (item.kind !== 'file') continue
    sawFile = true
    try {
      const file = item.getAsFile()
      if (!file) protectedFile = true
      else if (file.name.toLowerCase().endsWith('.json')) return 'accepted'
    } catch {
      protectedFile = true
    }
  }
  return sawFile && protectedFile ? 'delivery-only' : 'rejected'
}

/**
 * Window-wide drop target for restoring exported tapes. It just resolves dropped
 * files to paths and hands them to the shared importer (useImportMedia) — the same
 * call the menu's "Import" uses. Import is sidecar-driven: the importer keeps the
 * .json sidecars, and each names its own media + thumbnail (read from beside it).
 * So a user can drop a whole export folder (video + image + json) and only the json
 * drives the import; the files dropped alongside are pulled in via the sidecar.
 */
export function DropZone({ children }: Props) {
  const [active, setActive] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const importMedia = useImportMedia()

  function clearResetTimer() {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    resetTimer.current = null
  }

  function clearActive() {
    clearResetTimer()
    setActive(false)
  }

  function armIndependentReset() {
    clearResetTimer()
    // An OS drag cancelled over a webview need not deliver leave/drop/dragend.
    // Dragover repeats while the drag is live; silence means it ended elsewhere.
    resetTimer.current = setTimeout(clearActive, 1000)
  }

  useEffect(() => {
    const reset = () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current)
      resetTimer.current = null
      setActive(false)
    }
    window.addEventListener('blur', reset)
    window.addEventListener('dragend', reset)
    return () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current)
      window.removeEventListener('blur', reset)
      window.removeEventListener('dragend', reset)
    }
  }, [])

  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    if (inspectSidecarDragOffer(e.dataTransfer) !== 'accepted') {
      clearActive()
      return
    }
    setActive(true)
    armIndependentReset()
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    const offer = inspectSidecarDragOffer(e.dataTransfer)
    if (offer !== 'accepted') {
      e.dataTransfer.dropEffect = 'none'
      clearActive()
      return
    }
    e.dataTransfer.dropEffect = 'copy'
    setActive(true)
    armIndependentReset()
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    // Leaving a child element fires this too; require leaving the wrapper itself.
    if (e.currentTarget === e.target) clearActive()
  }

  async function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'none'
    clearActive()
    // Hand every dropped file's path to importMedia — it keeps the .json sidecars
    // (and guides the user if there are none). The video/image dropped alongside a
    // sidecar are read from the sidecar, not from the drop.
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => pathForFile(f))
      .filter((p): p is string => !!p && p.toLowerCase().endsWith('.json'))
    if (paths.length === 0) return
    e.dataTransfer.dropEffect = 'copy'
    await importMedia(paths)
  }

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative h-full"
    >
      {children}
      {active && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-zinc-950/70">
          <div className="rounded-lg border-2 border-dashed border-zinc-400 px-8 py-6 text-center">
            <p className="text-sm font-medium text-zinc-100">Drop to restore tapes</p>
            <p className="mt-1 text-xs text-zinc-300">Drop the .json sidecars — video &amp; image come along</p>
          </div>
        </div>
      )}
    </div>
  )
}
