import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { listPackage } from '@electron/asar'

const distDir = resolve('dist')
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
  throw new Error('No packaged TapeBox app.asar found under dist')
}

const entries = listPackage(archive, { isPack: false })
  .map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, ''))

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const required = [
  'package.json',
  'out/main/index.js',
  'out/preload/index.cjs',
  'out/renderer/index.html',
  ...Object.keys(packageJson.dependencies).map((name) => `node_modules/${name}/package.json`),
]

for (const path of required) {
  if (!entries.includes(path)) {
    throw new Error(`Packaged app is missing ${path}`)
  }
}

const allowedRoots = new Set(['node_modules', 'out', 'package.json'])
const unexpected = entries.filter((entry) => !allowedRoots.has(entry.split('/')[0]))
if (unexpected.length > 0) {
  throw new Error(`Packaged app contains unexpected files:\n${unexpected.slice(0, 20).join('\n')}`)
}

console.log(`Verified ${entries.length} app.asar entries in ${archive}`)
