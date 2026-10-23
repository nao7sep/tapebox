vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import OpenAI from 'openai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/settings'
import { describeError } from '@shared/error'

const mocks = vi.hoisted(() => ({ create: vi.fn(), handle: vi.fn(), writeRecord: vi.fn() }))
vi.mock('openai', async (original) => {
  const module = await original<typeof import('openai')>()
  return { ...module, default: class extends module.default {
    constructor(options: ConstructorParameters<typeof module.default>[0]) {
      super(options)
      this.chat.completions.create = mocks.create
    }
  } }
})
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('@main/store/config', () => ({ getSettings: defaultSettings, getLibraryDir: () => '/unused' }))
vi.mock('@main/store/session', () => ({ getTape: () => ({ title: 'Title', uploader: null, sidecarFilename: null }) }))
vi.mock('@main/services/api-keys', () => ({ resolveApiKey: async () => 'diagnostic-test-key' }))
vi.mock('@main/io/records', () => ({ writeRecord: mocks.writeRecord, toConsole: vi.fn() }))

// Real request owner, IPC failure boundary and logger; only transport and storage
// are substituted. Capture both the database row and its fallback serialization.
import { generateSlug } from '@main/services/ai-client'
import { registerAiHandlers } from '@main/ipc/ai'
import { log } from '@main/io/logger'

beforeEach(() => vi.clearAllMocks())

function recordedText(): string {
  return mocks.writeRecord.mock.calls.map(([table, row, fallback]) => JSON.stringify({ table, row, fallback: fallback() })).join('\n')
}

async function invoke(): Promise<unknown> {
  registerAiHandlers()
  const callback = mocks.handle.mock.calls.find(([channel]) => channel === 'ai:generateSlug')![1]
  return callback({}, { tapeId: 't1', requestId: 'request1', include: { title: true, uploader: false, description: false } })
}

describe('AI terminal diagnostic masking', () => {
  it('masks echoed keys in IPC replies, errors, causes, log rows and fallback text', async () => {
    const cause = new TypeError('nested diagnostic-test-key')
    const failure = new OpenAI.AuthenticationError(401, { message: 'Key diagnostic-test-key was refused' }, undefined, new Headers())
    failure.cause = cause
    mocks.create.mockRejectedValue(failure)
    const reply = await invoke()
    expect(JSON.stringify(reply)).toContain('[REDACTED]')
    expect(JSON.stringify(reply)).not.toContain('diagnostic-test-key')
    const text = recordedText()
    expect(text).toContain('ipc handler refused')
    expect(text).toContain('nested [REDACTED]')
    expect(text).toContain('TypeError')
    expect(text).toContain('stack')
    expect(text).not.toContain('diagnostic-test-key')
    expect(failure.message).toContain('diagnostic-test-key')
    expect(failure.cause).toBe(cause)
  })

  it('masks successful HTTP refusals before the IPC boundary sees them', async () => {
    const response = { choices: [{ finish_reason: 'stop', message: { refusal: 'Cannot use diagnostic-test-key', content: null } }] }
    mocks.create.mockResolvedValue(response)
    const reply = await invoke()
    expect(JSON.stringify(reply)).toContain('Cannot use [REDACTED]')
    expect(JSON.stringify(reply) + recordedText()).not.toContain('diagnostic-test-key')
    expect(response.choices[0]!.message.refusal).toContain('diagnostic-test-key')
  })

  it('keeps abort classification while masking its original terminal error', async () => {
    const controller = new AbortController()
    const error = new OpenAI.APIUserAbortError({ message: 'Stopped diagnostic-test-key' })
    mocks.create.mockImplementation(async () => { controller.abort(); throw error })
    let thrown: unknown
    try { await generateSlug({ tapeId: 't1', title: 'Title' }, controller.signal) } catch (failure) { thrown = failure }
    expect(thrown).toBeInstanceOf(OpenAI.APIUserAbortError)
    log.error('cancelled request', { error: describeError(thrown) })
    expect(recordedText()).not.toContain('diagnostic-test-key')
    expect(error.message).toContain('diagnostic-test-key')
  })
})


it('inserts selected metadata literally into a single prompt pass', async () => {
  mocks.create.mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { content: '{"slug":"literal-name"}' } }] })
  const title = "Price $$ $& $` $' {uploader}"
  const uploader = '{description} creator'
  const description = '{title} original description'
  await generateSlug({ tapeId: 'literal', title, uploader, description }, new AbortController().signal)
  const request = mocks.create.mock.calls[0]![0]
  const user = request.messages.find((entry: { role: string }) => entry.role === 'user').content
  expect(user).toContain(title)
  expect(user).toContain(uploader)
  expect(user).toContain(description)
})
