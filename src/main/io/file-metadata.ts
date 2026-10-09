import { chmod, stat } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'

// Ordinary file permissions and copy times (content-lifecycle conventions, Files).

/** A file's permissions and times, the times in seconds since the epoch. */
export interface FileStamp {
  mode: number
  atime: number
  mtime: number
}

export interface StampTarget {
  chmod(mode: number): Promise<void>
  utimes(atime: number, mtime: number): Promise<void>
}

/** Errors with which a volume refuses metadata it cannot hold. */
const CANNOT_HOLD = new Set(['EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'])

/** Whether `err` is a volume refusing metadata it cannot hold. */
function refusesMetadata(err: unknown): boolean {
  return CANNOT_HOLD.has((err as NodeJS.ErrnoException).code ?? '')
}

/** Set ordinary permission bits by path, where the volume can hold them. A volume
 * that cannot keeps its own ordinary mode, as a copy's stamp does. */
export async function chmodWhereHeld(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode)
  } catch (err) {
    if (!refusesMetadata(err)) throw err
  }
}

export function fileStampOf(stats: BigIntStats): FileStamp {
  const seconds = (ns: bigint) => Number(ns) / 1e9
  return {
    mode: Number(stats.mode & 0o777n),
    atime: seconds(stats.atimeNs),
    mtime: seconds(stats.mtimeNs),
  }
}

/** Apply ordinary permission bits and copy times through the runtime. */
export async function applyFileStamp(
  target: StampTarget,
  stamp: FileStamp,
): Promise<void> {
  try {
    await target.chmod(stamp.mode)
  } catch (err) {
    if (!refusesMetadata(err)) throw err
  }
  await target.utimes(stamp.atime, stamp.mtime)
}

/** Keep an existing target's ordinary permission bits on its replacement. */
export async function keepOriginalMode(
  originalPath: string,
  replacementPath: string,
): Promise<boolean> {
  let mode: number
  try {
    mode = (await stat(originalPath)).mode & 0o777
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  try {
    await chmod(replacementPath, mode)
  } catch (err) {
    if (!refusesMetadata(err)) throw err
  }
  return true
}
