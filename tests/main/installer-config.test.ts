import { describe, expect, it } from "vitest";

const { requiredRuntimeEntries, assertRequiredPackageEntries } = await import(
  new URL('../../scripts/package-entries.mjs', import.meta.url).href
) as { requiredRuntimeEntries: string[]; assertRequiredPackageEntries: (entries: string[], dependencies: Record<string, string>) => void }

describe('package runtime entries', () => {
  const complete = ['package.json', ...requiredRuntimeEntries, 'node_modules/example/package.json']
  it('accepts the complete runtime and dependencies', () => {
    expect(() => assertRequiredPackageEntries(complete, { example: '1' })).not.toThrow()
  })
  it.each(requiredRuntimeEntries)('rejects an archive missing %s', (missing) => {
    expect(() => assertRequiredPackageEntries(complete.filter((entry) => entry !== missing), { example: '1' })).toThrow(missing)
  })
})
