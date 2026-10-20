import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '@babel/parser'
import { describe, expect, it } from 'vitest'

// electron-vite adds its own __dirname and __filename to main-process bundles, so a
// module that declares either one fails to load with a syntax error; the main
// process uses import.meta.dirname and import.meta.filename instead. Read from
// each module's syntax tree.

const SHIMMED = new Set(['__dirname', '__filename'])

function declaredShims(source: string): string[] {
  const found: string[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    const record = node as { type?: string; id?: { type?: string; name?: string } }
    if ((record.type === 'VariableDeclarator' || record.type === 'FunctionDeclaration') && record.id?.type === 'Identifier' && SHIMMED.has(record.id.name!)) {
      found.push(record.id.name!)
    }
    for (const [key, value] of Object.entries(node)) if (key !== 'loc' && key !== 'start' && key !== 'end') visit(value)
  }
  visit(parse(source, { sourceType: 'module', plugins: ['typescript'] }).program)
  return found
}

function mainSources(dir = 'src/main'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return mainSources(path)
    return /\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

describe('main-process modules and the bundler\'s ESM shim', () => {
  it('finds a declared __dirname or __filename', () => {
    expect(declaredShims("import { fileURLToPath } from 'node:url'\nconst __dirname = fileURLToPath(new URL('.', import.meta.url))")).toEqual(['__dirname'])
    expect(declaredShims('let __filename = import.meta.filename')).toEqual(['__filename'])
    expect(declaredShims('const dir = import.meta.dirname')).toEqual([])
  })

  it('declare neither one', () => {
    const sources = mainSources()
    expect(sources.length).toBeGreaterThan(10)
    const offenders = sources.flatMap((path) => declaredShims(readFileSync(path, 'utf8')).map((name) => `${relative('.', path)}: ${name}`))
    expect(offenders).toEqual([])
  })
})
