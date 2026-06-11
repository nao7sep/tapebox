import { Modal } from '@renderer/components/Modal'
import { useRuntimeStore } from '@renderer/store/runtime'

const GITHUB_URL = 'https://github.com/nao7sep/tapebox'

export function AboutModal({ onClose }: { onClose: () => void }) {
  const version = useRuntimeStore((s) => s.info?.version)
  return (
    <Modal title="About TapeBox" onClose={onClose} size="md">
      <div className="space-y-4 text-sm">
        <div>
          <p className="text-lg font-medium text-zinc-100">
            TapeBox{version && <span className="ml-2 text-sm font-normal text-zinc-400">v{version}</span>}
          </p>
          <p className="mt-1 text-zinc-300">A local media library with web import.</p>
        </div>
        <div className="flex gap-4">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="text-zinc-300 hover:text-zinc-100">
            GitHub ↗
          </a>
          <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer" className="text-zinc-300 hover:text-zinc-100">
            Report an issue ↗
          </a>
        </div>
        <p className="text-zinc-300">© 2026 Yoshinao Inoguchi — MIT License</p>
      </div>
    </Modal>
  )
}
