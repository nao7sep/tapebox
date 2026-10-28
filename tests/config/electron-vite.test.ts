import { describe, expect, it } from 'vitest'

import config from '../../electron.vite.config'

describe('Electron development endpoint', () => {
  it('serves only on loopback, and fails rather than move to another port', () => {
    expect(config.renderer?.server).toMatchObject({ host: '127.0.0.1', strictPort: true })
  })
})
