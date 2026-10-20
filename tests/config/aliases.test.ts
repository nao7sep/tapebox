import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import config from '../../electron.vite.config'
import { ALIASES } from '../../aliases.config'

// electron-vite and Vitest build their aliases from aliases.config.ts; a tsconfig
// cannot import, so its `paths` are checked against the same table and against the
// aliases its program's bundle resolves.

// The tsconfigs carry only whole-line comments.
function pathsOf(file: string): Record<string, string[]> {
  const json = JSON.parse(readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  return json.compilerOptions.paths
}

function aliasesOf(paths: Record<string, string[]>): string[] {
  for (const [pattern, targets] of Object.entries(paths)) {
    const name = pattern.replace(/\/\*$/, '') as keyof typeof ALIASES
    expect(targets, pattern).toEqual([`./${ALIASES[name]}/*`])
  }
  return Object.keys(paths).map((pattern) => pattern.replace(/\/\*$/, '')).sort()
}

const keys = (alias: unknown) => Object.keys(alias as Record<string, string>).sort()

describe('import aliases', () => {
  it('match between the main program and the main and preload bundles', () => {
    const node = aliasesOf(pathsOf('tsconfig.node.json'))
    expect(node).toEqual([...new Set([...keys(config.main!.resolve!.alias), ...keys(config.preload!.resolve!.alias)])].sort())
  })

  it('match between the renderer program and the renderer bundle', () => {
    expect(aliasesOf(pathsOf('tsconfig.web.json'))).toEqual(keys(config.renderer!.resolve!.alias))
  })

  it('give the tests every alias the app uses', () => {
    expect(aliasesOf(pathsOf('tsconfig.test.json'))).toEqual(Object.keys(ALIASES).sort())
  })
})
