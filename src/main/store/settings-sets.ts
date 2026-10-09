import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { SETTINGS_KEYS, SettingsObjectSchema, type Settings, type SettingsSets } from '@shared/settings'

/**
 * The settings sets as main reads and saves them (config-sets-conventions): the
 * shared shape plus the rules that need Node. The renderer imports the shared
 * shape and so cannot carry `node:path`.
 */

/** The library and default export folders: blank, or an absolute path (storage-path-conventions). */
export const FolderSetSchema = z.string().refine((value) => value === '' || isAbsolute(value))

const StoredSettingsObjectSchema = SettingsObjectSchema.extend({
  libraryDir: FolderSetSchema,
  defaultExportDir: FolderSetSchema,
})

export const StoredSettingsSchema = StoredSettingsObjectSchema.partial()

/**
 * Decode each set independently. A copy that fails its check, and a key this
 * build does not know, are returned as written to be kept in the file; nothing
 * read is dropped (config-sets-conventions, The stored settings).
 */
export function readSettingsSets(
  raw: Record<string, unknown>,
): { sets: SettingsSets; kept: Record<string, unknown>; rejected: (keyof Settings)[] } {
  const sets: SettingsSets = {}
  // Entries, not assignment, so a key such as `__proto__` stays an own key.
  const kept: [string, unknown][] = []
  const rejected: (keyof Settings)[] = []
  const known = new Set<string>(SETTINGS_KEYS)
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) { kept.push([key, value]); continue }
    const parsed = StoredSettingsObjectSchema.shape[key as keyof Settings].safeParse(value)
    if (parsed.success) Object.assign(sets, { [key]: parsed.data })
    else { kept.push([key, value]); rejected.push(key as keyof Settings) }
  }
  return { sets, kept: Object.fromEntries(kept), rejected }
}
