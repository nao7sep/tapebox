import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { paths, log } = vi.hoisted(() => ({
  paths: { config: '', library: '/mock/library' },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@main/paths', () => ({ paths }))
vi.mock('@main/io/logger', () => ({ log }))
vi.mock('@main/store/backupStore', () => ({ record: vi.fn() }))

import { getSettings, loadSettings, readSettingsFile, updateSettings } from '@main/store/config'
import { defaultSettings } from '@shared/settings'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-config-sets-'))
  paths.config = join(dir, 'config.json')
  log.warn.mockClear()
})
afterEach(async () => rm(dir, { recursive: true, force: true }))

async function savedSets(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(paths.config, 'utf8')) as Record<string, unknown>
}

describe('settings by set', () => {
  it('launches with built-ins and no config file', async () => {
    expect(await loadSettings()).toEqual({ status: 'missing' })
    expect(getSettings()).toEqual(defaultSettings())
    expect(await readdir(dir)).toEqual([])
  })

  it('writes exactly the changed whole set', async () => {
    await loadSettings()
    const selection = { 'openai.slug': 'new-model' }
    await updateSettings(selection)
    expect(await savedSets()).toEqual(selection)
    expect(getSettings()).toEqual({ ...defaultSettings(), ...selection })
  })

  it('reads absent sets from built-ins without writing them', async () => {
    await writeFile(paths.config, JSON.stringify({ playSound: false }))
    await loadSettings()
    expect(getSettings()).toEqual({ ...defaultSettings(), playSound: false })
    expect(await savedSets()).toEqual({ playSound: false })
  })

  it('drops version and unknown keys at the next write, preserving untouched sets', async () => {
    await writeFile(paths.config, JSON.stringify({ version: 20, future: 'x', playSound: false }))
    await loadSettings()
    await updateSettings({ autoplay: false })
    expect(await savedSets()).toEqual({ playSound: false, autoplay: false })
  })

  it('rereads the file so a write retains a set changed outside the cache', async () => {
    await loadSettings()
    await writeFile(paths.config, JSON.stringify({ playSound: false }))
    await updateSettings({ autoplay: false })
    expect(await savedSets()).toEqual({ playSound: false, autoplay: false })
    expect(getSettings().playSound).toBe(false)
  })

  it('uses built-ins for malformed sets without quarantining or merging nested members', async () => {
    const raw = { 'openai.endpoint': 'http://remote.example', prompts: {}, language: 'unsupported', playSound: false }
    await writeFile(paths.config, JSON.stringify(raw))
    await loadSettings()
    await readSettingsFile(paths.config)
    expect(getSettings()).toEqual({ ...defaultSettings(), playSound: false })
    expect(await savedSets()).toEqual(raw)
    expect(await readdir(dir)).toEqual(['config.json'])
    expect(log.warn.mock.calls.map(([, fields]) => fields)).toEqual([
      { key: 'openai.endpoint' }, { key: 'prompts' }, { key: 'language' },
    ])
  })

  it('deletes the prompts copy while preserving every other stored set', async () => {
    await writeFile(paths.config, JSON.stringify({ prompts: { slug: 'custom' }, autoplay: false }))
    await loadSettings()
    await updateSettings({ prompts: null })
    expect(await savedSets()).toEqual({ autoplay: false })
    expect(getSettings().prompts).toEqual(defaultSettings().prompts)
  })

  it('resetting an absent model copy leaves a fresh config absent', async () => {
    await loadSettings()
    await updateSettings({ 'openai.slug': null })
    expect(await readdir(dir)).toEqual([])
  })

  it('drops the old AI set and resets only the selected model', async () => {
    await writeFile(paths.config, JSON.stringify({ ai: { baseUrl: 'https://old.example', model: 'old' }, 'openai.endpoint': 'https://proxy.example/v1', 'openai.slug': 'custom-model' }))
    await loadSettings()
    expect(getSettings()['openai.endpoint']).toBe('https://proxy.example/v1')
    await updateSettings({ 'openai.slug': null })
    expect(await savedSets()).toEqual({ 'openai.endpoint': 'https://proxy.example/v1' })
    expect(getSettings()['openai.slug']).toBe(defaultSettings()['openai.slug'])
  })

  it('quarantines corrupt bytes without reseeding a config', async () => {
    await writeFile(paths.config, '{broken')
    const result = await loadSettings()
    expect(result.status).toBe('recovered')
    if (result.status !== 'recovered') throw new Error('Expected recovery')
    expect(await readFile(result.quarantinePath, 'utf8')).toBe('{broken')
    expect(await readdir(dir)).toEqual([result.quarantinePath.slice(dir.length + 1)])
    expect(getSettings()).toEqual(defaultSettings())
  })

  it('serializes concurrent set writes without losing either copy', async () => {
    await loadSettings()
    await Promise.all([updateSettings({ autoplay: false }), updateSettings({ playSound: false })])
    expect(await savedSets()).toEqual({ autoplay: false, playSound: false })
  })
})
