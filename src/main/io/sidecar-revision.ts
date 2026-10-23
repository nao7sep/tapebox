import { stat } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
export function sidecarRevision(stats: BigIntStats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(':')
}
export async function assertSidecarRevision(path: string, expected: string): Promise<void> {
  if (sidecarRevision(await stat(path, { bigint: true })) !== expected) throw new Error('Sidecar changed during the operation')
}
