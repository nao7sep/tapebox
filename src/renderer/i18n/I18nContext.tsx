import { createContext, createElement, Fragment, useContext, useEffect, useMemo, type ReactNode } from 'react'
import type { MessageKey } from '@shared/i18n/catalogues'
import { isLanguage, type Language } from '@shared/i18n/languages'
import { createTranslator, type Translator } from '@shared/i18n/translate'

/** The shared translator plus markup placeholders, which only the renderer draws. */
export type UiTranslator = Translator & {
  // Like t, but a placeholder may be filled with markup (a <strong> label, say).
  rich: (key: MessageKey, values: Record<string, ReactNode>) => ReactNode
}

const PLACEHOLDER = /\{(\w+)\}/g

export function createUiTranslator(language: Language, locale: string = language): UiTranslator {
  const translator = createTranslator(language, locale)
  function rich(key: MessageKey, values: Record<string, ReactNode>): ReactNode {
    const parts = translator.template(key).split(PLACEHOLDER)
    // split with a capture group alternates literal text and placeholder names.
    return parts.map((part, index) =>
      index % 2 === 0
        ? part
        : createElement(Fragment, { key: index }, part in values ? values[part] : `{${part}}`),
    )
  }
  return { ...translator, rich }
}

// English until a provider says otherwise, so a component rendered on its own
// (in a test, say) still has text.
const I18nContext = createContext<UiTranslator>(createUiTranslator('en'))

export function I18nProvider({
  language,
  locale,
  children,
}: {
  language: Language
  locale: string
  children: ReactNode
}) {
  const translator = useMemo(() => createUiTranslator(language, locale), [language, locale])

  // <html lang> picks the right glyphs for Chinese, Japanese and Korean text and
  // tells the last-resort error boundary, which sits outside this provider,
  // which language to speak.
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>
}

export function useI18n(): UiTranslator {
  return useContext(I18nContext)
}

// For surfaces outside the provider: the language the document last declared.
export function documentTranslator(): UiTranslator {
  const declared = document.documentElement.lang
  return createUiTranslator(isLanguage(declared) ? declared : 'en')
}
