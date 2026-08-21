import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const script = fileURLToPath(new URL('../scripts/check-release-tag.mjs', import.meta.url))

async function run(tag: string): Promise<void> {
  await execFileAsync(process.execPath, [script], {
    env: { ...process.env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag },
  })
}

describe('release tag gate', () => {
  it('accepts the package version tag', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    await expect(run(`v${packageJson.version}`)).resolves.toBeUndefined()
  })

  it('rejects a tag for a different version', async () => {
    await expect(run('v9.9.9')).rejects.toMatchObject({ code: 1 })
  })
})
