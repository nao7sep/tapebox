import React from 'react'
import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'

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
    return (
      <main className="flex h-screen items-center justify-center bg-zinc-950 p-8 text-zinc-100" role="alert">
        <div className="w-full max-w-xl space-y-3">
          <h1 className="text-xl font-medium">TapeBox could not keep this window open.</h1>
          <p className="text-sm text-zinc-300">Reload the window to recover. Your library files are unchanged.</p>
          <button type="button" onClick={() => window.location.reload()} className="rounded border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">Reload window</button>
        </div>
      </main>
    )
  }
}
