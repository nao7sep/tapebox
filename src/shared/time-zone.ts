/**
 * The display zone (timestamp-conventions, Time zones): the zone user-facing times
 * are shown in. `system` follows the computer's zone on every launch, falling back
 * to UTC when it is unavailable; any other value is an IANA zone chosen from the
 * platform's list.
 */

export const SYSTEM_TIME_ZONE = 'system'

/** Whether the platform knows `zone` as a time zone. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The computer's zone now, or UTC when the platform reports none. */
export function computerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** The zone a saved choice shows times in. */
export function displayTimeZone(choice: string, computer: string = computerTimeZone()): string {
  return choice === SYSTEM_TIME_ZONE ? computer : choice
}

/** The zones offered after System: the platform's IANA list. */
export function timeZoneChoices(): readonly string[] {
  return Intl.supportedValuesOf('timeZone')
}
