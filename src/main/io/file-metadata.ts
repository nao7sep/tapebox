import { lstat, unlink, writeFile } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { nanoid } from 'nanoid'
import { execCapture } from './spawn'

/**
 * What a copy keeps of its source's own metadata (content-lifecycle conventions,
 * Files): the permissions and times live here, the extended attributes, Finder
 * tags among them, in {@link copyExtendedAttributes}.
 */

/** A file's permissions and times, the times in seconds since the epoch. */
export interface FileStamp {
  mode: number
  atime: number
  mtime: number
  birthtime: number
}

export interface StampTarget {
  chmod(mode: number): Promise<void>
  utimes(atime: number, mtime: number): Promise<void>
}

/** Errors with which a volume refuses metadata it cannot hold. */
const CANNOT_HOLD = new Set(['EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'])

export function fileStampOf(stats: BigIntStats): FileStamp {
  const seconds = (ns: bigint) => Number(ns) / 1e9
  return {
    mode: Number(stats.mode & 0o777n),
    atime: seconds(stats.atimeNs),
    mtime: seconds(stats.mtimeNs),
    birthtime: seconds(stats.birthtimeNs),
  }
}

/**
 * Give a copy its source's permissions and times. The modified time always holds;
 * permissions a volume refuses are dropped. macOS lowers a file's birth time to an
 * earlier modified time it is given, so there the birth time goes in first and the
 * real times after it; a volume whose birth time does not follow keeps its own.
 * Other platforms offer no way to set a birth time, so a copy there has a new one.
 */
export async function applyFileStamp(
  target: StampTarget,
  stamp: FileStamp,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  try {
    await target.chmod(stamp.mode)
  } catch (err) {
    if (!CANNOT_HOLD.has((err as NodeJS.ErrnoException).code ?? '')) throw err
  }
  if (platform === 'darwin' && stamp.birthtime > 0 && stamp.birthtime < stamp.mtime) {
    await target.utimes(stamp.atime, stamp.birthtime)
  }
  await target.utimes(stamp.atime, stamp.mtime)
}

const XATTR = '/usr/bin/xattr'
const XATTR_CALL_TIMEOUT_MS = 10_000
const PROBE_ATTRIBUTE = 'io.github.nao7sep.tapebox.probe'

/**
 * Copy every extended attribute of `sourcePath`, Finder tags among them, onto
 * `destPath`. Node has no extended-attribute API, so this runs macOS's own `xattr`
 * tool. It writes only where the destination volume holds extended attributes
 * natively: elsewhere, such as exFAT, FAT or a share without streams, macOS would
 * keep them in `._` files, and the copy drops them instead. An attribute the
 * volume refuses, or one too large to pass to the tool (in practice only a classic
 * resource fork), is dropped too. Other platforms keep no attributes TapeBox can
 * read, so there this does nothing.
 */
export async function copyExtendedAttributes(
  sourcePath: string,
  destPath: string,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'darwin') return
  const listed = await xattr([sourcePath], signal)
  const names = listed.exitCode === 0 ? listed.stdout.split('\n').filter((name) => name.length > 0) : []
  if (names.length === 0) return
  if (!(await holdsExtendedAttributesNatively(dirname(destPath), signal))) return

  for (const name of names) {
    const value = await xattr(['-px', name, sourcePath], signal)
    if (value.exitCode !== 0) continue
    const hex = value.stdout.replace(/\s+/g, '')
    try {
      await xattr(['-wx', name, hex, destPath], signal)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'E2BIG') throw err
    }
  }
}

/** Whether `dir`'s volume keeps extended attributes itself rather than in `._`
 * files, tried on a small probe file that is removed again. */
async function holdsExtendedAttributesNatively(dir: string, signal?: AbortSignal): Promise<boolean> {
  const probe = join(dir, `.tapebox-xattr-probe-${nanoid(10)}.tmp`)
  const appleDouble = join(dir, `._${basename(probe)}`)
  await writeFile(probe, '', { flag: 'wx' })
  try {
    const written = await xattr(['-w', PROBE_ATTRIBUTE, '1', probe], signal)
    return written.exitCode === 0 && !(await exists(appleDouble))
  } finally {
    await unlink(probe).catch(() => {})
    await unlink(appleDouble).catch(() => {})
  }
}

/** One bounded call of the `xattr` tool. A refusal is its exit code; a stall past
 * the bound, a cancellation or a failure to start throws. */
function xattr(args: string[], signal?: AbortSignal) {
  const bound = AbortSignal.timeout(XATTR_CALL_TIMEOUT_MS)
  return execCapture(XATTR, args, {
    reject: false,
    signal: signal ? AbortSignal.any([signal, bound]) : bound,
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}
