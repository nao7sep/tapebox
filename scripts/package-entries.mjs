// Shared build inputs define the runtime files a packaged archive must contain.
import { readFileSync } from 'node:fs'
const inputs = JSON.parse(readFileSync(new URL('../runtime-entries.json', import.meta.url), 'utf8'))

export const requiredRuntimeEntries = [
  ...Object.keys(inputs.main).map((name) => `out/main/${name}.js`),
  ...Object.keys(inputs.preload).map((name) => `out/preload/${name}.cjs`),
  ...Object.keys(inputs.renderer).map((name) => `out/renderer/${name}.html`),
]

export function assertRequiredPackageEntries(entries, dependencies) {
  const present = new Set(entries)
  const required = ['package.json', ...requiredRuntimeEntries,
    ...Object.keys(dependencies).map((name) => `node_modules/${name}/package.json`)]
  for (const path of required) {
    if (!present.has(path)) throw new Error(`Packaged app is missing ${path}`)
  }
}
