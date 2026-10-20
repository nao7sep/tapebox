import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import { RendererErrorBoundary } from './components/RendererErrorBoundary'
import { RecordsApp } from './records/RecordsWindow'
import { installWindowActivityState } from './lib/windowActivity'
import { tapeboxBridge } from '@shared/bridge'

// The Records window's page (main/records-window.ts opens it).
const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Renderer root element missing')

const bridge = tapeboxBridge()
installWindowActivityState(bridge.onWindowActivityChanged, document.documentElement)

createRoot(rootEl).render(
  <React.StrictMode>
    <RendererErrorBoundary><RecordsApp /></RendererErrorBoundary>
  </React.StrictMode>,
)
