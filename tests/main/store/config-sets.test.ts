import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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

import { getSettings, loadSettings, updateSettings } from '@main/store/config'
import { DEFAULT_SLUG_PROMPT, defaultSettings } from '@shared/settings'

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

  it('writes from the loaded settings, not from the file as it is now', async () => {
    await loadSettings()
    await writeFile(paths.config, JSON.stringify({ playSound: false }))
    await updateSettings({ autoplay: false })
    expect(await savedSets()).toEqual({ autoplay: false })
    expect(getSettings().playSound).toBe(true)
  })

  it('reads a relative folder as its built-in and drops it at the next save', async () => {
    await writeFile(paths.config, JSON.stringify({ libraryDir: 'relative/library', defaultExportDir: 'exports', autoplay: false }))
    await loadSettings()
    expect(getSettings()).toEqual({ ...defaultSettings(), autoplay: false })
    expect(log.warn.mock.calls.map(([, fields]) => fields)).toEqual([{ key: 'libraryDir' }, { key: 'defaultExportDir' }])
    await updateSettings({ playSound: false })
    expect(await savedSets()).toEqual({ autoplay: false, playSound: false })
  })

  it('refuses a relative folder on save and keeps the file as it is', async () => {
    await writeFile(paths.config, JSON.stringify({ autoplay: false }))
    await loadSettings()
    await expect(updateSettings({ libraryDir: 'relative/library' })).rejects.toThrow()
    await expect(updateSettings({ defaultExportDir: 'exports' })).rejects.toThrow()
    expect(await savedSets()).toEqual({ autoplay: false })
  })

  it('uses built-ins for malformed sets without quarantining or merging nested members', async () => {
    const raw = { 'openai.endpoint': 'http://remote.example', prompts: {}, language: 'unsupported', playSound: false }
    await writeFile(paths.config, JSON.stringify(raw))
    await loadSettings()
    expect(getSettings()).toEqual({ ...defaultSettings(), playSound: false })
    expect(await savedSets()).toEqual(raw)
    expect(await readdir(dir)).toEqual(['config.json'])
    expect(log.warn.mock.calls.map(([, fields]) => fields)).toEqual([
      { key: 'openai.endpoint' }, { key: 'prompts' }, { key: 'language' },
    ])
  })

  it('removes a set saved back to its built-in while preserving every other stored set', async () => {
    await writeFile(paths.config, JSON.stringify({ prompts: { slug: 'custom' }, autoplay: false }))
    await loadSettings()
    await updateSettings({ prompts: { slug: DEFAULT_SLUG_PROMPT } })
    expect(await savedSets()).toEqual({ autoplay: false })
    expect(getSettings().prompts).toEqual(defaultSettings().prompts)
  })

  it('removes every stored copy equal to its built-in, untouched ones included', async () => {
    await writeFile(paths.config, JSON.stringify({ playSound: true, theme: 'system', autoplay: false }))
    await loadSettings()
    await updateSettings({ autoplay: true })
    expect(await savedSets()).toEqual({})
  })

  it('saving the built-in into a fresh config writes nothing', async () => {
    await loadSettings()
    await updateSettings({ 'openai.slug': defaultSettings()['openai.slug'], prompts: defaultSettings().prompts })
    expect(await readdir(dir)).toEqual([])
  })

  it('writes nothing when the result equals the file', async () => {
    await writeFile(paths.config, JSON.stringify({ autoplay: false }))
    const before = await stat(paths.config)
    await loadSettings()
    await updateSettings({ autoplay: false, playSound: true })
    expect((await stat(paths.config)).mtimeMs).toBe(before.mtimeMs)
    expect(await readFile(paths.config, 'utf8')).toBe(JSON.stringify({ autoplay: false }))
  })

  it('compares text after cleanup and a model id trimmed and case-insensitive', async () => {
    await writeFile(paths.config, JSON.stringify({ 'openai.slug': 'custom-model', prompts: { slug: 'custom' } }))
    await loadSettings()
    await updateSettings({
      'openai.slug': ` ${defaultSettings()['openai.slug'].toUpperCase()} `,
      prompts: { slug: `\n${DEFAULT_SLUG_PROMPT.replaceAll('\n', '  \r\n')}\n\n` },
    })
    expect(await savedSets()).toEqual({})
  })

  it('stores text in its cleaned form and paths exactly as given', async () => {
    await loadSettings()
    await updateSettings({
      'openai.endpoint': ' https://proxy.example/v1\n',
      prompts: { slug: '\n  Name {title}  \r\n\n' },
      externalPlayer: ' /Applications/My Player.app ',
      defaultExportDir: '/exports/ ',
    })
    expect(await savedSets()).toEqual({
      'openai.endpoint': 'https://proxy.example/v1',
      prompts: { slug: '  Name {title}' },
      externalPlayer: ' /Applications/My Player.app ',
      defaultExportDir: '/exports/ ',
    })
  })

  it('stores a role\'s thinking only while it differs from the default for the selected model', async () => {
    await loadSettings()
    await updateSettings({ 'openai.slug': 'gpt-6.1-sol', 'openai.thinking.slug': 'medium' })
    expect(await savedSets()).toEqual({ 'openai.slug': 'gpt-6.1-sol' })
    await updateSettings({ 'openai.thinking.slug': 'none' })
    expect(await savedSets()).toEqual({ 'openai.slug': 'gpt-6.1-sol' })
    await updateSettings({ 'openai.thinking.slug': 'high' })
    expect(await savedSets()).toEqual({ 'openai.slug': 'gpt-6.1-sol', 'openai.thinking.slug': 'high' })
    await updateSettings({ 'openai.slug': 'gpt-6-luna', 'openai.thinking.slug': 'none' })
    expect(await savedSets()).toEqual({})
    await updateSettings({ 'openai.slug': 'local-model', 'openai.thinking.slug': 'high' })
    expect(await savedSets()).toEqual({ 'openai.slug': 'local-model' })
  })

  it('rejects an empty endpoint or model id and keeps the file as it is', async () => {
    await writeFile(paths.config, JSON.stringify({ autoplay: false }))
    await loadSettings()
    await expect(updateSettings({ 'openai.endpoint': '' })).rejects.toThrow()
    await expect(updateSettings({ 'openai.slug': ' \n ' })).rejects.toThrow()
    expect(await savedSets()).toEqual({ autoplay: false })
    expect(getSettings()).toEqual({ ...defaultSettings(), autoplay: false })
  })

  it('drops the old AI set and removes only the model saved back to its built-in', async () => {
    await writeFile(paths.config, JSON.stringify({ ai: { baseUrl: 'https://old.example', model: 'old' }, 'openai.endpoint': 'https://proxy.example/v1', 'openai.slug': 'custom-model' }))
    await loadSettings()
    expect(getSettings()['openai.endpoint']).toBe('https://proxy.example/v1')
    await updateSettings({ 'openai.slug': defaultSettings()['openai.slug'] })
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
