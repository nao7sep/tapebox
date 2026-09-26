import React from 'react'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import { documentTranslator } from '@renderer/i18n/I18nContext'

export class RendererErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    log.error('renderer stopped unexpectedly', {
      error: describeError(error),
      componentStack: info.componentStack ?? '',
    })
  }

  override render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    // Outside the language provider: speak the language the document last declared.
    const t = documentTranslator()
    return (
      <main className="flex h-screen items-center justify-center bg-canvas p-8 text-fg-strong" role="alert">
        <div className="w-full max-w-xl space-y-3">
          <h1 className="text-xl font-medium">{t.t('errorBoundary.title')}</h1>
          <p className="text-sm text-fg">{t.t('errorBoundary.body')}</p>
          <button type="button" onClick={() => window.location.reload()} className="rounded border border-line-strong bg-raised px-3 py-1.5 text-sm hover:bg-raised-hover">{t.t('errorBoundary.reload')}</button>
        </div>
      </main>
    )
  }
}
