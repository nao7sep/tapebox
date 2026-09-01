import { describe, expect, it } from 'vitest'
import { ipcRequestSchemas } from '@main/ipc/schemas'

/**
 * The IPC contract is type-only, so these schemas are the sole runtime guard at the
 * main-process trust boundary. The `satisfies` clause in schemas.ts already proves
 * (at compile time) that every channel has a schema whose output matches its req
 * type; these tests pin the runtime behavior — that bad input is actually rejected.
 */
describe('ipcRequestSchemas — validation at the IPC trust boundary', () => {
  it('accepts a well-formed request', () => {
    expect(ipcRequestSchemas['downloads:add'].safeParse({ url: 'https://x' }).success).toBe(true)
  })

  it('rejects a request missing a required field', () => {
    expect(ipcRequestSchemas['downloads:add'].safeParse({}).success).toBe(false)
    expect(ipcRequestSchemas['library:rename'].safeParse({ tapeId: 'a' }).success).toBe(false)
  })

  it('rejects a wrongly-typed field', () => {
    expect(
      ipcRequestSchemas['library:remove'].safeParse({ tapeIds: 'not-an-array', deleteFiles: true }).success,
    ).toBe(false)
  })

  it('requires a known binary and a nonempty correlated operation id', () => {
    expect(ipcRequestSchemas['binaries:update'].safeParse({ name: 'bogus', operationId: 'op-1' }).success).toBe(false)
    expect(ipcRequestSchemas['binaries:update'].safeParse({ name: 'yt-dlp' }).success).toBe(false)
    expect(ipcRequestSchemas['binaries:update'].safeParse({ name: 'yt-dlp', operationId: 'op-1' }).success).toBe(true)
    expect(ipcRequestSchemas['binaries:cancelUpdate'].safeParse({ name: 'bogus', operationId: 'op-1' }).success).toBe(false)
    expect(ipcRequestSchemas['binaries:cancelUpdate'].safeParse({ name: 'ffmpeg', operationId: '' }).success).toBe(false)
    expect(ipcRequestSchemas['binaries:cancelUpdate'].safeParse({ name: 'ffmpeg', operationId: 'op-1' }).success).toBe(true)
  })

  it('requires bare undefined for a no-argument channel', () => {
    expect(ipcRequestSchemas['library:list'].safeParse(undefined).success).toBe(true)
    expect(ipcRequestSchemas['library:list'].safeParse({ sneaky: 1 }).success).toBe(false)
  })

  it('strips unknown keys from an object request', () => {
    const parsed = ipcRequestSchemas['downloads:add'].parse({ url: 'https://x', extra: 1 }) as Record<string, unknown>
    expect('extra' in parsed).toBe(false)
  })
})
