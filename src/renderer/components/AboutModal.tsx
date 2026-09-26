import { Modal } from '@renderer/components/Modal'
import { Button, InlineError } from '@renderer/components/ui'
import { useRuntimeStore } from '@renderer/store/runtime'
import { ExternalLinkIcon } from './Icon'
import { ipcInvoke } from '@renderer/ipc/client'
import { presentFailure } from '@renderer/lib/presentFailure'
import { useRef, useState } from 'react'
import { useI18n } from '@renderer/i18n/I18nContext'
import { message, type Message } from '@shared/i18n/translate'

const GITHUB_URL = 'https://github.com/nao7sep/tapebox'

export function AboutModal({ onClose }: { onClose: () => void }) {
  const version = useRuntimeStore((s) => s.info?.version)
  const t = useI18n()
  const [linkErrors, setLinkErrors] = useState<Record<'repository' | 'issues', Message | undefined>>({
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
      const failure = presentFailure(
        error,
        message(owner === 'repository' ? 'about.repositoryOpenFailed' : 'about.issuesOpenFailed'),
        'About link open failed',
      )
      if (linkAttempts.current[owner] !== attempt) return
      setLinkErrors((current) => ({ ...current, [owner]: failure }))
    }
  }
  return (
    <Modal
      title={t.t('nativeMenu.about', { app: 'TapeBox' })}
      titleHidden
      onClose={onClose}
      size="md"
      footer={
        <Button variant="ghost" onClick={onClose}>
          {t.t('common.close')}
        </Button>
      }
    >
      <div className="space-y-4 text-sm">
        <div>
          <p className="text-[26px] font-semibold leading-tight tracking-tight text-fg-strong">TapeBox</p>
          {version && <p className="mt-0.5 text-sm text-fg-muted">{t.t('about.version', { version })}</p>}
          <p className="mt-3 text-fg">{t.t('about.tagline')}</p>
        </div>
        <div className="flex gap-4">
          <button type="button" onClick={() => void openLink('repository', GITHUB_URL)} className="whitespace-nowrap bg-transparent p-0 text-fg hover:text-fg-strong">
            GitHub <ExternalLinkIcon />
          </button>
          <button type="button" onClick={() => void openLink('issues', `${GITHUB_URL}/issues`)} className="whitespace-nowrap bg-transparent p-0 text-fg hover:text-fg-strong">
            {t.t('about.reportIssue')} <ExternalLinkIcon />
          </button>
        </div>
        {linkErrors.repository && <InlineError onDismiss={() => setLinkErrors((current) => ({ ...current, repository: undefined }))} closeLabel={t.t('about.closeRepositoryResult')}>{t.text(linkErrors.repository)}</InlineError>}
        {linkErrors.issues && <InlineError onDismiss={() => setLinkErrors((current) => ({ ...current, issues: undefined }))} closeLabel={t.t('about.closeIssuesResult')}>{t.text(linkErrors.issues)}</InlineError>}
        <p className="text-fg">{t.t('about.copyright')}</p>
      </div>
    </Modal>
  )
}
