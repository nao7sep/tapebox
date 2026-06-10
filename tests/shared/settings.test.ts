import { describe, expect, it } from 'vitest'
import { defaultSettings, SettingsSchema } from '@shared/settings'

describe('SettingsSchema', () => {
  it('defaults log retention for configs that do not have the field yet', () => {
    const raw = settingsWithoutRetainLogCount()

    expect(SettingsSchema.parse(raw).retainLogCount).toBe(50)
  })

  it('preserves an explicit zero log-retention value', () => {
    const raw = { ...settingsWithoutRetainLogCount(), retainLogCount: 0 }

    expect(SettingsSchema.parse(raw).retainLogCount).toBe(0)
  })
})

function settingsWithoutRetainLogCount(): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...defaultSettings('/tmp/tapebox-library') }
  delete raw['retainLogCount']
  return raw
}
