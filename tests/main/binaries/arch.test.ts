import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertArm64Slice } from '@main/binaries/arch'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'tapebox-mach-o-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

function thin(cpu = 0x0100000c, subtype = 0, little = true): Buffer {
  const buffer = Buffer.alloc(32)
  const write = little ? buffer.writeUInt32LE.bind(buffer) : buffer.writeUInt32BE.bind(buffer)
  write(0xfeedfacf, 0)
  write(cpu, 4)
  write(subtype, 8)
  write(2, 12)
  return buffer
}

function fat(cpus: number[], wide: boolean, little: boolean): Buffer {
  const entrySize = wide ? 32 : 20
  const tableEnd = 8 + cpus.length * entrySize
  const buffer = Buffer.alloc(tableEnd + cpus.length * 32)
  const write = little ? buffer.writeUInt32LE.bind(buffer) : buffer.writeUInt32BE.bind(buffer)
  const write64 = little ? buffer.writeBigUInt64LE.bind(buffer) : buffer.writeBigUInt64BE.bind(buffer)
  write(wide ? 0xcafebabf : 0xcafebabe, 0)
  write(cpus.length, 4)
  for (const [index, cpu] of cpus.entries()) {
    const entry = 8 + index * entrySize
    const offset = tableEnd + index * 32
    write(cpu, entry)
    if (wide) { write64(BigInt(offset), entry + 8); write64(32n, entry + 16) }
    else { write(offset, entry + 8); write(32, entry + 12) }
    thin(cpu).copy(buffer, offset)
  }
  return buffer
}

async function inspect(bytes: Buffer, signal?: AbortSignal): Promise<void> {
  const path = join(directory, 'tool')
  await writeFile(path, bytes)
  return assertArm64Slice(path, signal)
}

describe('staged native Mach-O admission', () => {
  it.each([true, false])('accepts thin arm64 and arm64e headers (little endian: %s)', async (little) => {
    await expect(inspect(thin(0x0100000c, 0, little))).resolves.toBeUndefined()
    await expect(inspect(thin(0x0100000c, 2, little))).resolves.toBeUndefined()
  })

  it.each([[false, false], [false, true], [true, false], [true, true]])('accepts a universal header (wide: %s, little endian: %s)', async (wide, little) => {
    await expect(inspect(fat([0x01000007, 0x0100000c], wide, little))).resolves.toBeUndefined()
  })

  it('rejects x86-only, unknown, truncated and out-of-range artifacts', async () => {
    await expect(inspect(thin(0x01000007))).rejects.toThrow('not arm64-native')
    await expect(inspect(fat([0x01000007], false, false))).rejects.toThrow('not arm64-native')
    await expect(inspect(Buffer.from('not an executable'))).rejects.toThrow('not arm64-native')
    await expect(inspect(thin().subarray(0, 20))).rejects.toThrow('truncated')
    const table = fat([0x0100000c], false, false)
    table.writeUInt32BE(0xffffffff, 4)
    await expect(inspect(table)).rejects.toThrow('truncated')
    const outside = fat([0x0100000c], true, false)
    outside.writeBigUInt64BE(0xffffffffffffffffn, 16)
    await expect(inspect(outside)).rejects.toThrow('slice range')
    const mislabeled = fat([0x0100000c], false, false)
    thin(0x01000007).copy(mislabeled, 28)
    await expect(inspect(mislabeled)).rejects.toThrow('not arm64-native')
  })

  it('honors cancellation before inspection', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(inspect(thin(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
