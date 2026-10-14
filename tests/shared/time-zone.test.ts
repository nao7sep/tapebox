import { describe, expect, it } from 'vitest'
import { computerTimeZone, displayTimeZone, isTimeZone, SYSTEM_TIME_ZONE, timeZoneChoices } from '@shared/time-zone'
import { defaultSettings, SettingsSchema } from '@shared/settings'

describe('the display zone', () => {
  it('defaults to System, which follows the computer', () => {
    expect(defaultSettings().timeZone).toBe(SYSTEM_TIME_ZONE)
    expect(displayTimeZone(SYSTEM_TIME_ZONE, 'Asia/Tokyo')).toBe('Asia/Tokyo')
    expect(displayTimeZone(SYSTEM_TIME_ZONE)).toBe(computerTimeZone())
  })

  it('shows a chosen zone as it is', () => {
    expect(displayTimeZone('Europe/Berlin', 'Asia/Tokyo')).toBe('Europe/Berlin')
  })

  it('accepts System and the platform\'s zones, and refuses anything else', () => {
    expect(timeZoneChoices()).toContain('Asia/Tokyo')
    expect(isTimeZone('Asia/Tokyo')).toBe(true)
    expect(isTimeZone('Mars/Olympus')).toBe(false)
    expect(SettingsSchema.safeParse({ timeZone: 'system' }).success).toBe(true)
    expect(SettingsSchema.safeParse({ timeZone: 'America/New_York' }).success).toBe(true)
    expect(SettingsSchema.safeParse({ timeZone: 'JST+9' }).success).toBe(false)
  })
})
