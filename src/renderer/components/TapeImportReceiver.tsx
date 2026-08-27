import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { pathForFile } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { useImportMedia } from '@renderer/lib/useImportMedia'
import {
  droppedFileOperationKey,
  inspectExternalFileOffer,
  resolveDroppedPaths,
} from '@renderer/lib/externalDrop'
import { useImportResultStore } from '@renderer/store/importResult'
import { describeError } from '@shared/error'
import { CloseIcon } from './Icon'

export function TapeImportReceiver({ children }: { children: ReactNode }) {
  const [deliveryActive, setDeliveryActive] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const importMedia = useImportMedia()

  const clearActive = useCallback(() => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    resetTimer.current = null
    setDeliveryActive(false)
  }, [])

  const showDelivery = useCallback(() => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    setDeliveryActive(true)
    // Native drags may end without leave/drop/dragend. This clears pixels only;
    // the receiver remains authoritative if a later drop arrives here.
    resetTimer.current = setTimeout(clearActive, 1000)
  }, [clearActive])

  useEffect(() => {
    window.addEventListener('blur', clearActive)
    window.addEventListener('dragend', clearActive)
    return () => {
      window.removeEventListener('blur', clearActive)
      window.removeEventListener('dragend', clearActive)
      if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    }
  }, [clearActive])

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (inspectExternalFileOffer(event.dataTransfer) === 'rejected') return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    showDelivery()
  }

  async function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'none'
    clearActive()

    if (inspectExternalFileOffer(event.dataTransfer) === 'rejected') {
      await importMedia([], [{
        path: 'Dropped content',
        reason: 'Drop one or more local files; TapeBox imports tapes from .json sidecars.',
        severity: 'warning',
      }], { operationKey: 'drop', entryKey: 'drop' })
      return
    }

    const files = Array.from(event.dataTransfer.files)
    const attempt = files.length > 0
      ? { operationKey: droppedFileOperationKey(files), entryKey: 'drop' }
      : { operationKey: 'drop', entryKey: 'drop' }
    const resolved = resolveDroppedPaths(files, pathForFile)
    for (const failure of resolved.errors) {
      log.error('dropped file path resolution failed', {
        fileName: failure.fileName,
        error: describeError(failure.error),
      })
    }
    event.dataTransfer.dropEffect = 'copy'
    await importMedia(resolved.paths, resolved.issues, attempt)
  }

  return (
    <div
      data-drop-receiver="tape-collection"
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        const next = event.relatedTarget
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) clearActive()
      }}
      onDrop={(event) => void onDrop(event)}
      className={
        'relative flex min-h-0 flex-1 flex-col overflow-hidden rounded ' +
        (deliveryActive ? 'bg-amber-400/10 ring-2 ring-inset ring-amber-400' : '')
      }
    >
      {children}
      <ImportResultNotice />
    </div>
  )
}

function ImportResultNotice() {
  const result = useImportResultStore((state) => state.result)
  const clear = useImportResultStore((state) => state.clear)
  if (!result) return null

  const severity = result.issues.some((item) => item.severity === 'error')
    ? 'error'
    : result.issues.some((item) => item.severity === 'warning')
      ? 'warning'
      : 'information'
  const allDuplicates = result.issues.length > 0 &&
    result.issues.every((item) => item.reason === 'already in library')
  const lead = result.imported.length > 0
    ? allDuplicates
      ? `Added ${result.imported.length} new ${result.imported.length === 1 ? 'tape' : 'tapes'}; ${result.issues.length} ${result.issues.length === 1 ? 'was' : 'were'} already in the library.`
      : `Added ${result.imported.length} ${result.imported.length === 1 ? 'tape' : 'tapes'}; ${result.issues.length} ${result.issues.length === 1 ? 'item was not added' : 'items were not added'}.`
    : allDuplicates
      ? result.issues.length === 1 ? 'That tape is already in the library.' : 'Those tapes are already in the library.'
      : severity === 'error' ? 'The import failed.' : 'The selection could not be imported.'

  const palette = severity === 'error'
    ? 'border-red-500/90 bg-red-950/80 text-red-100'
    : severity === 'warning'
      ? 'border-amber-500/90 bg-amber-950/80 text-amber-100'
      : 'border-sky-500/80 bg-sky-950/70 text-sky-100'
  const detailColor = severity === 'error'
    ? 'text-red-100/90'
    : severity === 'warning' ? 'text-amber-100/90' : 'text-sky-100/90'
  const dismissColor = severity === 'error'
    ? 'text-red-200 hover:bg-red-900 hover:text-red-50'
    : severity === 'warning'
      ? 'text-amber-200 hover:bg-amber-900 hover:text-amber-50'
      : 'text-sky-200 hover:bg-sky-900 hover:text-sky-50'

  return (
    <section
      role="status"
      aria-atomic="true"
      className={`m-3 mt-0 rounded-md border px-3 py-2.5 shadow-sm ${palette}`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{lead}</p>
          <ul className={`mt-1.5 space-y-1 text-xs ${detailColor}`}>
            {result.issues.map((item, index) => (
              <li key={`${item.path}-${index}`}>
                <span className="font-medium">{basename(item.path)}:</span> {item.reason}
              </li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          onClick={clear}
          aria-label="Dismiss import result"
          className={`shrink-0 rounded p-1 ${dismissColor}`}
        >
          <CloseIcon />
        </button>
      </div>
    </section>
  )
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}
