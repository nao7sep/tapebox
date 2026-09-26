import { describe, expect, it } from 'vitest'
import type { MessageKey } from '@shared/i18n/catalogues'
import { createTranslator, joinMessages, message } from '@shared/i18n/translate'

describe('createTranslator', () => {
  it('fills placeholders and formats numbers for the locale', () => {
    expect(createTranslator('en').t('about.version', { version: '1.2.0' })).toBe('Version 1.2.0')
    expect(createTranslator('en', 'en-US').t('status.tapes', { count: 12345 })).toBe('12,345 tapes')
    expect(createTranslator('de').t('status.tapes', { count: 12345 })).toMatch(/^12\.345 /)
  })

  it('chooses the plural form by the language’s own rules', () => {
    const en = createTranslator('en')
    expect(en.t('status.tapes', { count: 1 })).toBe('1 tape')
    expect(en.t('status.tapes', { count: 0 })).toBe('0 tapes')
    const ru = createTranslator('ru')
    const forms = [1, 3, 5, 21].map((count) => ru.t('status.tapes', { count }))
    expect(new Set(forms.map((form) => form.replace(/^\d+ /, ''))).size).toBe(3)
    expect(forms[0]!.replace(/^\d+ /, '')).toBe(forms[3]!.replace(/^\d+ /, ''))
  })

  it('renders a message descriptor, including a message nested as a value', () => {
    const t = createTranslator('en')
    expect(t.text(message('errors.aiHttp', { status: '404' }))).toContain('(HTTP 404)')
    expect(t.text(joinMessages(message('status.downloading', { count: 2 }), message('status.queued', { count: 1 }))))
      .toBe('2 downloading · 1 queued')
  })

  it('formats sizes, rates, lists and elapsed time for the locale', () => {
    const en = createTranslator('en', 'en-US')
    expect(en.bytes(142 * 1024 * 1024)).toBe('142 MB')
    expect(en.bytes(4.2 * 1024 * 1024)).toBe('4.2 MB')
    expect(en.bytesPerSecond(4.2 * 1024 * 1024)).toBe('4.2 MB/s')
    expect(createTranslator('de').bytes(4.2 * 1024 * 1024)).toBe('4,2 MB')
    expect(en.list(['yt-dlp', 'ffmpeg'])).toBe('yt-dlp, ffmpeg')
    expect(en.relativeTime(5, 'minute')).toBe('5 minutes ago')
    expect(en.relativeTime(0, 'second')).toBe('now')
  })

  it('shows a key the catalogue lacks instead of failing the render', () => {
    // Types keep this out of the app; a stale build or a half-merged catalogue
    // could still reach it, and a window must not go down over one string.
    const missing = 'gone.missing' as unknown as MessageKey
    expect(createTranslator('ja').t(missing)).toBe('gone.missing')
  })
})
