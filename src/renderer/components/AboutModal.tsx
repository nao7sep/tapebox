import { Modal } from '@renderer/components/Modal'
import { Button, InlineError } from '@renderer/components/ui'
import { useRuntimeStore } from '@renderer/store/runtime'
import { ExternalLinkIcon } from './Icon'
import { ipcInvoke } from '@renderer/ipc/client'
import { presentFailure } from '@renderer/lib/presentFailure'
import { useState } from 'react'

const GITHUB_URL = 'https://github.com/nao7sep/tapebox'

export function AboutModal({ onClose }: { onClose: () => void }) {
  const version = useRuntimeStore((s) => s.info?.version)
  const [linkError, setLinkError] = useState<string | null>(null)

  async function openLink(url: string): Promise<void> {
    setLinkError(null)
    try {
      await ipcInvoke('app:openExternal', { url })
    } catch (error) {
      setLinkError(presentFailure(
        error,
        'The link could not be opened in your browser. Try again.',
        'About link open failed',
      ))
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
          <button type="button" onClick={() => void openLink(GITHUB_URL)} className="whitespace-nowrap bg-transparent p-0 text-zinc-300 hover:text-zinc-100">
            GitHub <ExternalLinkIcon />
          </button>
          <button type="button" onClick={() => void openLink(`${GITHUB_URL}/issues`)} className="whitespace-nowrap bg-transparent p-0 text-zinc-300 hover:text-zinc-100">
            Report an issue <ExternalLinkIcon />
          </button>
        </div>
        {linkError && <InlineError onDismiss={() => setLinkError(null)} closeLabel="Close link result">{linkError}</InlineError>}
        <p className="text-zinc-300">© 2026 Yoshinao Inoguchi — MIT License</p>
      </div>
    </Modal>
  )
}
