import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)
const expected = `v${packageJson.version}`
const refType = process.env.GITHUB_REF_TYPE
const actual = process.env.GITHUB_REF_NAME

if (refType === 'tag' && actual !== expected) {
  console.error(`Release tag ${actual ?? '(missing)'} does not match package version ${expected}`)
  process.exitCode = 1
}
