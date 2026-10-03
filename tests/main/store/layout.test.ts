import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The Records window's list width lives in layout.json beside the main window's
// panes. Each window patches only its own field, and main merges every patch, so
// neither window's save overwrites the other's.

const prevHome = process.env.TAPEBOX_DATA_DIR
const roots: string[] = []

afterEach(() => {
  if (prevHome === undefined) delete process.env.TAPEBOX_DATA_DIR
  else process.env.TAPEBOX_DATA_DIR = prevHome
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function freshLayout() {
  const root = mkdtempSync(join(tmpdir(), 'tapebox-layout-'))
  roots.push(root)
  process.env.TAPEBOX_DATA_DIR = root
  vi.resetModules()
  const layout = await import('@main/store/layout')
  const { paths } = await import('@main/paths')
  return { layout, paths }
}

describe('layout store', () => {
  it('saves the Records list width without touching the main window panes, and restores it', async () => {
    const { layout, paths } = await freshLayout()
    await layout.loadLayout()
    layout.updateLayout({ leftPaneWidth: 400 })
    expect(layout.updateLayout({ recordsListWidth: 512 })).toMatchObject({ leftPaneWidth: 400, recordsListWidth: 512 })
    await layout.persistNow()
    expect(JSON.parse(readFileSync(paths.layout, 'utf8'))).toMatchObject({ leftPaneWidth: 400, recordsListWidth: 512 })

    vi.resetModules()
    const reloaded = await import('@main/store/layout')
    await reloaded.loadLayout()
    expect(reloaded.getLayout().recordsListWidth).toBe(512)
  })
})
