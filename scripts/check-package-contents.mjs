// Checks a packaged build: app.asar holds the built app and its runtime
// dependencies and nothing else, and the extra resources sit beside it.
// Run by `npm run check:package`, which `npm run dist` calls after packaging.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { assertRequiredPackageEntries } from './package-entries.mjs'
import { listPackage } from '@electron/asar'

const distDir = resolve(process.argv[2] ?? 'dist')
const candidates = process.platform === 'win32'
  ? [join(distDir, 'win-unpacked', 'resources', 'app.asar')]
  : []

if (process.platform === 'darwin' && existsSync(distDir)) {
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('mac')) {
      candidates.push(join(distDir, entry.name, 'TapeBox.app', 'Contents', 'Resources', 'app.asar'))
    }
  }
}

const archive = candidates.find((candidate) => existsSync(candidate))
if (!archive) {
  throw new Error(`No packaged TapeBox app.asar found under ${distDir}`)
}

const entries = listPackage(archive, { isPack: false })
  .map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, ''))

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
assertRequiredPackageEntries(entries, packageJson.dependencies)

const allowedRoots = new Set(['node_modules', 'out', 'package.json'])
const unexpected = entries.filter((entry) => !allowedRoots.has(entry.split('/')[0]))
if (unexpected.length > 0) {
  throw new Error(`Packaged app contains unexpected files:\n${unexpected.slice(0, 20).join('\n')}`)
}

// The suffixes build.files excludes ("!**/*.map" and the like) must be absent.
const excludedSuffixes = packageJson.build.files
  .filter((pattern) => pattern.startsWith('!**/*'))
  .map((pattern) => pattern.slice('!**/*'.length))
const developmentMetadata = entries.filter((entry) => excludedSuffixes.some((suffix) => entry.endsWith(suffix)))
if (developmentMetadata.length > 0) {
  throw new Error(`Packaged app contains development metadata:\n${developmentMetadata.slice(0, 20).join('\n')}`)
}

// Each extra resource the build names lands beside app.asar.
for (const { to } of packageJson.build.extraResources) {
  if (!existsSync(join(dirname(archive), to))) throw new Error(`Packaged app is missing the resource ${to}`)
}

console.log(`Verified ${entries.length} app.asar entries in ${archive}`)
