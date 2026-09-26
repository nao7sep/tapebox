import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/globals.css'
import { RendererErrorBoundary } from './components/RendererErrorBoundary'
import { I18nProvider } from './i18n/I18nContext'
import { useInterfaceLanguage } from './i18n/useInterfaceLanguage'
import { installWindowActivityState } from './lib/windowActivity'
import type { TapeBoxApi } from '@shared/bridge'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Renderer root element missing')

const bridge = (window as unknown as { tapebox: TapeBoxApi }).tapebox
installWindowActivityState(bridge.onWindowActivityChanged, document.documentElement)

// The interface language is known before the first render (main hands it to
// preload synchronously), so the first words on screen are already in it.
function LocalizedApp() {
  const { language, locale } = useInterfaceLanguage()
  return <I18nProvider language={language} locale={locale}><App /></I18nProvider>
}

createRoot(rootEl).render(
  <React.StrictMode>
    <RendererErrorBoundary><LocalizedApp /></RendererErrorBoundary>
  </React.StrictMode>,
)
