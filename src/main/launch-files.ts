import { checkApiKeysAtLaunch } from './services/api-keys.js'
import { loadSettings, type ConfigLoadResult } from './store/config.js'
import { loadDependencies } from './store/dependencies.js'
import { loadLayout } from './store/layout.js'
import { loadSession, type SessionLoadResult } from './store/session.js'
import { flushRecords, recordsRefusal } from './io/records.js'
import { openBackupStore } from './store/backupStore.js'
import { LaunchRefusedError, refusalOf, type RefusedFile } from './io/store-access.js'

/** What the launch read, once every file it reads has passed. */
export type LaunchFiles = {
  settings: ConfigLoadResult
  session: SessionLoadResult
  /** records.sqlite3 or backups.sqlite3 when it could not be read: off for this launch. */
  records: RefusedFile | null
  backups: RefusedFile | null
}

export type LaunchLoaders = {
  loadSettings: () => Promise<ConfigLoadResult>
  /** Runs once the settings are in, before anything else is read. */
  afterSettings: () => Promise<void>
  checkApiKeys: () => Promise<void>
  loadDependencies: () => Promise<void>
  loadSession: () => Promise<SessionLoadResult>
  loadLayout: () => Promise<void>
  openRecords: () => Promise<RefusedFile | null>
  openBackups: () => Promise<RefusedFile | null>
}

export const LAUNCH_LOADERS: Omit<LaunchLoaders, 'afterSettings'> = {
  loadSettings,
  checkApiKeys: checkApiKeysAtLaunch,
  loadDependencies,
  loadSession: () => loadSession({ prepare: false }),
  loadLayout,
  openRecords: async () => { await flushRecords(); return recordsRefusal() },
  openBackups: openBackupStore,
}

/**
 * Read every file the launch reads, writing none of them (store-recovery-conventions,
 * What a refused file does). A refused file is collected rather than thrown, so
 * the stop names every one found: settings, keys, the shelf and the shelf's
 * newer tape files, and any newer file at all. Unreadable layout and tool facts
 * fall back inside their stores; an unreadable records or backup database is
 * off for the launch and returned, to be told.
 */
export async function loadLaunchFiles(loaders: LaunchLoaders): Promise<LaunchFiles> {
  const refused: RefusedFile[] = []
  const unlessRefused = async <T>(load: () => Promise<T>): Promise<T | null> => {
    try { return await load() } catch (error) {
      const file = refusalOf(error)
      if (!file) throw error
      refused.push(file)
      return null
    }
  }
  const settings = await unlessRefused(loaders.loadSettings)
  if (settings) await loaders.afterSettings()
  await unlessRefused(loaders.checkApiKeys)
  await unlessRefused(loaders.loadDependencies)
  // The collection's folder is a setting, so a refused config.json leaves it unread.
  const session = settings ? await unlessRefused(loaders.loadSession) : null
  for (const tape of session?.damaged ?? []) if (tape.newer) refused.push({ path: tape.path, reason: 'newer' })
  await unlessRefused(loaders.loadLayout)
  const records = await loaders.openRecords()
  const backups = await loaders.openBackups()
  for (const store of [records, backups]) if (store?.reason === 'newer') refused.push(store)
  if (refused.length > 0 || !settings || !session) throw new LaunchRefusedError(refused)
  return { settings, session, records, backups }
}
