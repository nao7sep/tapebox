import { Modal } from '@renderer/components/Modal'
import { Button, InlineError } from '@renderer/components/ui'
import { useRuntimeStore } from '@renderer/store/runtime'
import { ExternalLinkIcon } from './Icon'
import { ipcInvoke } from '@renderer/ipc/client'
import { presentFailure } from '@renderer/lib/presentFailure'
import { useRef, useState } from 'react'

const GITHUB_URL = 'https://github.com/nao7sep/tapebox'

export function AboutModal({ onClose }: { onClose: () => void }) {
  const version = useRuntimeStore((s) => s.info?.version)
  const [linkErrors, setLinkErrors] = useState<Record<'repository' | 'issues', string | undefined>>({
    repository: undefined,
    issues: undefined,
  })
  const linkAttempts = useRef<Record<'repository' | 'issues', number>>({ repository: 0, issues: 0 })

  async function openLink(owner: 'repository' | 'issues', url: string): Promise<void> {
    const attempt = ++linkAttempts.current[owner]
    try {
      await ipcInvoke('app:openExternal', { url })
      if (linkAttempts.current[owner] !== attempt) return
      setLinkErrors((current) => ({ ...current, [owner]: undefined }))
    } catch (error) {
      const message = presentFailure(
        error,
        owner === 'repository'
          ? 'GitHub could not be opened in your browser. Try again.'
          : 'Report an issue could not be opened in your browser. Try again.',
        'About link open failed',
      )
      if (linkAttempts.current[owner] !== attempt) return
      setLinkErrors((current) => ({ ...current, [owner]: message }))
    }
  }
  return (
    <Modal
      title="About TapeBox"
      onClose={onClose}
      size="md"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-4 text-sm">
        <div>
          <p className="text-lg font-medium text-zinc-100">
            TapeBox{version && <span className="ml-2 text-sm font-normal text-zinc-400">v{version}</span>}
          </p>
          <p className="mt-1 text-zinc-300">A local media library with web import.</p>
        </div>
        <div className="flex gap-4">
          <button type="button" onClick={() => void openLink('repository', GITHUB_URL)} className="whitespace-nowrap bg-transparent p-0 text-zinc-300 hover:text-zinc-100">
            GitHub <ExternalLinkIcon />
          </button>
          <button type="button" onClick={() => void openLink('issues', `${GITHUB_URL}/issues`)} className="whitespace-nowrap bg-transparent p-0 text-zinc-300 hover:text-zinc-100">
            Report an issue <ExternalLinkIcon />
          </button>
        </div>
        {linkErrors.repository && <InlineError onDismiss={() => setLinkErrors((current) => ({ ...current, repository: undefined }))} closeLabel="Close GitHub result">{linkErrors.repository}</InlineError>}
        {linkErrors.issues && <InlineError onDismiss={() => setLinkErrors((current) => ({ ...current, issues: undefined }))} closeLabel="Close Report an issue result">{linkErrors.issues}</InlineError>}
        <p className="text-zinc-300">© 2026 Yoshinao Inoguchi — MIT License</p>
      </div>
    </Modal>
  )
}
