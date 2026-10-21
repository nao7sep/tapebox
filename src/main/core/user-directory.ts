import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { FolderSetSchema } from '@main/store/settings-sets'
import { UserFacingError } from '@main/user-facing-error'
import { message } from '@shared/i18n/translate'

/**
 * Normalize a user-typed folder setting (libraryDir, defaultExportDir) at the
 * boundary, before it is stored or used: absolute paths stay literal; otherwise
 * whitespace is trimmed and a leading ~ / ~/ / ~\ is expanded to home.
 * A value its set schema refuses is reported with the folder's own message.
 */
export function normalizeUserDir(
  notAbsolute: 'errors.libraryFolderNotAbsolute' | 'errors.exportFolderNotAbsolute',
  value: string,
): string {
  // Absolute paths include literal native selections; never trim their names.
  let expanded = isAbsolute(value) ? value : value.trim()
  if (expanded === '~') expanded = homedir()
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = join(homedir(), expanded.slice(2))
  }
  if (!FolderSetSchema.safeParse(expanded).success) {
    throw new UserFacingError('invalid', message(notAbsolute))
  }
  return expanded
}
