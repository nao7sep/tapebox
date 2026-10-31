import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APP_WRITER } from '@main/io/app-writer'

describe('APP_WRITER', () => {
  it('is the package as package.json names it, in lowercase', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { name: string; version: string }
    expect(APP_WRITER).toEqual({ name: pkg.name, version: pkg.version })
    expect(APP_WRITER.name).toMatch(/^[a-z0-9]+$/)
  })
})
