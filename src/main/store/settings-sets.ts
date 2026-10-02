import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { SETTINGS_KEYS, SettingsObjectSchema, type Settings, type SettingsSets } from '@shared/settings'

/**
 * The settings sets as main reads and saves them (config-sets-conventions,
 * Reading and healing): the shared shape plus the rules that need Node. The
 * renderer imports the shared shape and so cannot carry `node:path`.
 */

/** The library and default export folders: blank, or an absolute path (storage-path-conventions). */
export const FolderSetSchema = z.string().refine((value) => value === '' || isAbsolute(value))

const StoredSettingsObjectSchema = SettingsObjectSchema.extend({
  libraryDir: FolderSetSchema,
  defaultExportDir: FolderSetSchema,
})

export const StoredSettingsSchema = StoredSettingsObjectSchema.partial()

/** Decode each set independently, reporting malformed copies without merging members. */
export function readSettingsSets(
  raw: Record<string, unknown>,
  invalid: (key: keyof Settings) => void,
): SettingsSets {
  const sets: SettingsSets = {}
  for (const key of SETTINGS_KEYS) {
    if (!Object.hasOwn(raw, key)) continue
    const parsed = StoredSettingsObjectSchema.shape[key].safeParse(raw[key])
    if (parsed.success) Object.assign(sets, { [key]: parsed.data })
    else invalid(key)
  }
  return sets
}
