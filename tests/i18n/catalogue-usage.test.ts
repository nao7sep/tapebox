import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATALOGUES } from '@shared/i18n/catalogues'

// Every catalogue key is named somewhere in the shipped source, so a surface
// that stops using one leaves no stale entry for nine translators to maintain.
// Keys the source builds from parts are matched by their family.

const SOURCE = join(process.cwd(), 'src')

// startup-dialog.ts builds `startup.${notice}.title` and its siblings.
const BUILT_FAMILIES = [/^startup\.\w+\.(title|message|detail)$/]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

describe('catalogue keys', () => {
  it('are each named in the source', () => {
    const text = sourceFiles(SOURCE).map((file) => readFileSync(file, 'utf8')).join('\n')
    const named = new Set([...text.matchAll(/['"`]([A-Za-z]\w*(?:\.\w+)+)['"`]/g)].map((match) => match[1]))
    const unused = Object.keys(CATALOGUES.en).filter(
      (key) => !named.has(key) && !BUILT_FAMILIES.some((family) => family.test(key)),
    )
    expect(unused).toEqual([])
  })
})
