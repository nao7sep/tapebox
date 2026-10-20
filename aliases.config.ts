import { resolve } from 'node:path'

/**
 * The import aliases each part of the app uses, in one place: electron-vite and
 * Vitest build theirs from here, and a test checks the tsconfig `paths` against
 * them, since a tsconfig cannot import.
 */
export const ALIASES = {
  '@shared': 'src/shared',
  '@main': 'src/main',
  '@renderer': 'src/renderer',
} as const

export type AliasName = keyof typeof ALIASES

/** The resolved alias map for the named aliases, every one when none is named. */
export function aliasMap(...names: AliasName[]): Record<string, string> {
  const chosen = names.length > 0 ? names : (Object.keys(ALIASES) as AliasName[])
  return Object.fromEntries(chosen.map((name) => [name, resolve(ALIASES[name])]))
}
