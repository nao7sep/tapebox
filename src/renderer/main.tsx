import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/globals.css'
import { RendererErrorBoundary } from './components/RendererErrorBoundary'
import { installWindowActivityState } from './lib/windowActivity'
import type { TapeBoxApi } from '@shared/bridge'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Renderer root element missing')

const bridge = (window as unknown as { tapebox: TapeBoxApi }).tapebox
installWindowActivityState(bridge.onWindowActivityChanged, document.documentElement)

createRoot(rootEl).render(
  <React.StrictMode>
    <RendererErrorBoundary><App /></RendererErrorBoundary>
  </React.StrictMode>,
)
