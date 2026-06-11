import type { ImportResult } from '@shared/ipc-contract'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/ui'

type Props = { result: ImportResult; onClose: () => void }

/**
 * Blocking summary of an import: what entered the library and what didn't (with
 * reasons), so nothing silently vanishes. Each section appears only when it has
 * something to show — an import where everything was a duplicate shows just the
 * skipped list, not a hollow "Imported (0)". The skipped reasons sit in a plain
 * list (a subtle left rule per item) rather than a boxed red frame that would
 * indent them away from everything else.
 */
export function ImportResultModal({ result, onClose }: Props) {
  const { imported, rejected } = result

  const footer = (
    <Button variant="primary" onClick={onClose}>
      Done
    </Button>
  )

  return (
    <Modal title="Import results" onClose={onClose} size="md" footer={footer}>
      <div className="space-y-5">
        {imported.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-xs font-medium text-zinc-300">
              Added {imported.length} {imported.length === 1 ? 'tape' : 'tapes'}
            </h3>
            <ul className="space-y-1">
              {imported.map((tape) => (
                <li key={tape.id} className="truncate text-sm text-zinc-100">
                  {tape.title ?? tape.filename ?? tape.sourceUrl}
                </li>
              ))}
            </ul>
          </section>
        )}

        {rejected.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-xs font-medium text-zinc-400">
              {imported.length > 0
                ? `Skipped ${rejected.length}`
                : `Couldn’t import ${rejected.length === 1 ? 'this' : `these ${rejected.length}`}`}
            </h3>
            <ul className="space-y-2">
              {rejected.map((r) => (
                <li key={r.path} className="border-l-2 border-zinc-700 pl-2.5 text-xs">
                  <div className="truncate text-zinc-200">{basename(r.path)}</div>
                  <div className="text-zinc-400">{r.reason}</div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {imported.length === 0 && rejected.length === 0 && (
          <p className="text-sm text-zinc-400">Nothing to import.</p>
        )}
      </div>
    </Modal>
  )
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}
