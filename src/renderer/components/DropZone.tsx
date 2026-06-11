import { useState, type DragEvent, type ReactNode } from 'react'
import { pathForFile } from '@renderer/ipc/client'
import { useImportMedia } from '@renderer/lib/useImportMedia'

type Props = { children: ReactNode }

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
  const importMedia = useImportMedia()

  function isFileDrag(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files')
  }

  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return
    e.preventDefault()
    setActive(true)
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    // Leaving a child element fires this too; require leaving the wrapper itself.
    if (e.currentTarget === e.target) setActive(false)
  }

  async function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return
    e.preventDefault()
    setActive(false)
    // Hand every dropped file's path to importMedia — it keeps the .json sidecars
    // (and guides the user if there are none). The video/image dropped alongside a
    // sidecar are read from the sidecar, not from the drop.
    const paths = Array.from(e.dataTransfer?.files ?? [])
      .map((f) => pathForFile(f))
      .filter((p): p is string => !!p)
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
            <p className="mt-1 text-xs text-zinc-300">drop the .json sidecars — video &amp; image come along</p>
          </div>
        </div>
      )}
    </div>
  )
}
