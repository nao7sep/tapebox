import { useState } from 'react'
import type { Item } from '@shared/domain'
import { ipcInvoke } from '@renderer/ipc/client'

type Props = {
  item: Item
  onClose: () => void
}

/**
 * Rename the on-disk media + sidecar to a slug. AI button calls
 * ai:generateSlug to seed the input; user can edit before applying.
 * Collisions / invalid slugs / missing AI config show as inline errors.
 */
export function RenameDialog({ item, onClose }: Props) {
  const [slug, setSlug] = useState(item.slug ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'generate' | 'apply' | null>(null)

  async function generate() {
    setError(null)
    setBusy('generate')
    try {
      const result = await ipcInvoke('ai:generateSlug', { itemId: item.id })
      setSlug(result.slug)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  async function apply() {
    setError(null)
    setBusy('apply')
    try {
      await ipcInvoke('library:renameToSlug', { itemId: item.id, slug })
      onClose()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
        <h2 className="text-base font-medium">Rename to slug</h2>
        <p className="mt-1 text-xs text-zinc-500 truncate">
          Current: <span className="text-zinc-300">{item.filename ?? '—'}</span>
        </p>

        <div className="mt-4 space-y-2">
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="lowercase-kebab-slug"
            spellCheck={false}
            className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
          />
          <button
            onClick={generate}
            disabled={busy !== null}
            className="text-xs text-zinc-400 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'generate' ? 'Generating…' : '✨ Generate with AI'}
          </button>
        </div>

        {error && (
          <p className="mt-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy !== null}
            className="rounded border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={apply}
            disabled={busy !== null || !slug.trim()}
            className="rounded bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {busy === 'apply' ? 'Renaming…' : 'Rename'}
          </button>
        </div>
      </div>
    </div>
  )
}
