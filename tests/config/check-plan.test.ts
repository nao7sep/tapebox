import { describe, expect, it } from 'vitest'
// @ts-expect-error The directly executed .mjs helper intentionally has no declaration file.
import { planChecks, readsRepository } from '../../scripts/check-plan.mjs'

const repositoryReaders = ['tests/config/launcher-runtime.test.ts', 'tests/main/installer-config.test.ts']

function plan(changed: string[]) {
  return planChecks({ changed, full: false, repositoryReaders })
}

describe('the default check plan', () => {
  it('runs nothing when nothing differs from HEAD or only documentation changed', () => {
    expect(plan([])).toEqual({ typecheck: false, vitest: null })
    expect(plan(['README.md', 'CHANGELOG.md'])).toEqual({ typecheck: false, vitest: null })
  })

  it('typechecks and runs related tests for a TypeScript change', () => {
    expect(plan(['src/main/queue/queue.ts'])).toEqual({
      typecheck: true,
      vitest: ['src/main/queue/queue.ts'],
    })
  })

  it('adds every repository-reading test when a file outside the module graph changes', () => {
    expect(plan(['src/renderer/index.css'])).toEqual({
      typecheck: false,
      vitest: ['src/renderer/index.css', ...repositoryReaders],
    })
  })

  it('typechecks when the TypeScript configuration or dependencies change', () => {
    expect(plan(['tsconfig.web.json']).typecheck).toBe(true)
    expect(plan(['package-lock.json']).typecheck).toBe(true)
  })
})

describe('the full check plan', () => {
  it('typechecks and runs every test regardless of changes', () => {
    expect(planChecks({ changed: [], full: true, repositoryReaders })).toEqual({ typecheck: true, vitest: 'all' })
  })
})

describe('repository readers', () => {
  it('are the tests that read files through Node', () => {
    expect(readsRepository("import { readFile } from 'node:fs/promises'")).toBe(true)
    expect(readsRepository('import { readFileSync } from "node:fs";')).toBe(true)
    expect(readsRepository("import { existsSync } from 'fs'")).toBe(true)
    expect(readsRepository("const fs = await import('node:fs')")).toBe(true)
    expect(readsRepository("import path from 'node:path'")).toBe(false)
    expect(readsRepository("import { fsync } from './fsync'")).toBe(false)
  })
})
