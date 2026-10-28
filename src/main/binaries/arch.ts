import { open, type FileHandle } from 'node:fs/promises'

const ARM64 = 0x0100000c

// Mach-O layouts: Apple's mach-o/loader.h and mach-o/fat.h. Read only fixed-size
// headers, never executable contents, and require the declared slice to exist.
// This gate must work on Macs without Xcode's lipo command.
function arm64Header(header: Buffer): boolean {
  const magic = header.readUInt32BE(0)
  if (magic !== 0xfeedfacf && magic !== 0xcffaedfe) return false
  const read = magic === 0xcffaedfe ? header.readUInt32LE.bind(header) : header.readUInt32BE.bind(header)
  const subtype = read(8) & 0x00ffffff
  return read(4) === ARM64 && (subtype === 0 || subtype === 2)
}

async function readHeader(file: FileHandle, offset: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length)
  let position = 0
  while (position < length) {
    const { bytesRead } = await file.read(bytes, position, length - position, offset + position)
    if (bytesRead === 0) throw new Error('downloaded binary has a truncated Mach-O header')
    position += bytesRead
  }
  return bytes
}

/** Inspect the staged artifact before publication. Thin arm64/arm64e and fat
 * wrappers are accepted without invoking a developer tool or executing bytes. */
export async function assertArm64Slice(filePath: string): Promise<void> {
  const file = await open(filePath, 'r')
  try {
    const size = (await file.stat()).size
    const header = await readHeader(file, 0, 8)
    const magic = header.readUInt32BE(0)
    if (magic === 0xfeedfacf || magic === 0xcffaedfe) {
      if (arm64Header(await readHeader(file, 0, 32))) return
    } else if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
      const little = magic === 0xbebafeca || magic === 0xbfbafeca
      const wide = magic === 0xcafebabf || magic === 0xbfbafeca
      const count = little ? header.readUInt32LE(4) : header.readUInt32BE(4)
      const entrySize = wide ? 32 : 20
      const tableEnd = 8 + count * entrySize
      if (tableEnd > size) throw new Error('downloaded binary has a truncated Mach-O architecture table')
      let native = false
      for (let index = 0; index < count; index++) {
        const entry = await readHeader(file, 8 + index * entrySize, entrySize)
        const u32 = little ? entry.readUInt32LE.bind(entry) : entry.readUInt32BE.bind(entry)
        const u64 = little ? entry.readBigUInt64LE.bind(entry) : entry.readBigUInt64BE.bind(entry)
        const offset = wide ? u64(8) : BigInt(u32(8))
        const length = wide ? u64(16) : BigInt(u32(12))
        if (offset < BigInt(tableEnd) || length < 32n || offset + length > BigInt(size)) {
          throw new Error('downloaded binary has an invalid Mach-O slice range')
        }
        if (u32(0) === ARM64) {
          const slice = await readHeader(file, Number(offset), 32)
          native ||= arm64Header(slice)
        }
      }
      if (native) return
    }
    throw new Error('downloaded binary is not arm64-native')
  } finally {
    await file.close()
  }
}
