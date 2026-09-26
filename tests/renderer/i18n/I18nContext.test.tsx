// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nProvider, documentTranslator, useI18n } from '@renderer/i18n/I18nContext'
import { CATALOGUES } from '@shared/i18n/catalogues'
import type { Language } from '@shared/i18n/languages'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

function Probe() {
  const t = useI18n()
  return createElement('p', null, t.t('status.tapes', { count: 3 }), ' ', t.rich('detail.listingBody', { scanPage: createElement('strong', null, 'S') }))
}

function render(language: Language) {
  act(() => root!.render(createElement(I18nProvider, { language, locale: language, children: createElement(Probe) })))
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
  document.documentElement.lang = ''
})

describe('I18nProvider', () => {
  it('speaks the chosen language, declares it on the document, and follows a change at once', () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)

    render('ja')
    expect(document.documentElement.lang).toBe('ja')
    expect(host.textContent).toContain('3 本のテープ')

    render('de')
    expect(document.documentElement.lang).toBe('de')
    expect(host.textContent).toContain('3 Bänder')
    expect(host.querySelector('strong')?.textContent).toBe('S')
  })

  it('lets a surface outside the provider speak the language the document last declared', () => {
    document.documentElement.lang = 'fr'
    expect(documentTranslator().t('errorBoundary.reload')).toBe(CATALOGUES.fr['errorBoundary.reload'])
    document.documentElement.lang = 'not-a-language'
    expect(documentTranslator().language).toBe('en')
  })
})
