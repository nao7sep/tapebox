import { useState, type DragEvent, type ReactNode } from 'react'
import { pathForFile } from '@renderer/ipc/client'
import { useToastStore } from '@renderer/store/toast'
import { useImportMedia } from '@renderer/lib/useImportMedia'

type Props = { children: ReactNode }

/**
 * Window-wide drop target. Accepts media + sidecar pairs to restore tapes
 * into the library. Bare media files without a matching .json are rejected
 * by the main import handler.
 *
 * Drop UX:
 *   - Files dragged from the OS get their real paths via webUtils.
 *   - .json files alone are ignored at the renderer (no media to pair).
 *   - Outcome surfaces as a transient app toast (see store/toast); the
 *     status bar shows the headline, the console keeps the per-file reasons.
 */
export function DropZone({ children }: Props) {
  const [active, setActive] = useState(false)
  const notify = useToastStore((s) => s.notify)
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
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return

    const mediaPaths: string[] = []
    for (const f of files) {
      const path = pathForFile(f)
      if (!path) continue
      if (path.toLowerCase().endsWith('.json')) continue // sidecar discovered automatically by stem
      mediaPaths.push(path)
    }
    if (mediaPaths.length === 0) {
      notify('Drop media files — sidecar JSON is paired automatically by name.', 'info')
      return
    }

    await importMedia(mediaPaths)
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
            <p className="mt-1 text-xs text-zinc-300">media + sidecar JSON pairs only</p>
          </div>
        </div>
      )}
    </div>
  )
}
