import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import config from '../../electron.vite.config'

describe('Electron development endpoint', () => {
  it('serves only on loopback, and fails rather than move to another port', () => {
    expect(config.renderer?.server).toMatchObject({ host: '127.0.0.1', strictPort: true })
  })

  // The run-dev launchers check and wait on the dev server's address, so each must
  // name the port the config serves on.
  it.each(['scripts/run-dev.command', 'scripts/run-dev.ps1'])('%s checks and waits on the configured port', (launcher) => {
    const { host, port } = config.renderer!.server!
    const ports = [...readFileSync(launcher, 'utf8').matchAll(new RegExp(`${String(host).replaceAll('.', '\\.')}[:"',\\s]+(\\d+)`, 'g'))]
      .map((match) => Number(match[1]))
    expect(ports.length).toBeGreaterThanOrEqual(2)
    expect(new Set(ports)).toEqual(new Set([port]))
  })
})
