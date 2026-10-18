import { deflateSync } from 'node:zlib'

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type)
  let crc = 0xffff_ffff
  for (const byte of Buffer.concat([name, data])) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0)
  }
  const header = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE((crc ^ 0xffff_ffff) >>> 0)
  return Buffer.concat([header, name, data, checksum])
}

/** A deterministic, valid PNG whose base64 exceeds the old 100,000-byte gate.
 * Generate pixels rather than committing a user's screenshot or a large blob. */
export function suggestionImageFixture(): string {
  const width = 320
  const height = 240
  const stride = width * 3 + 1
  const pixels = Buffer.alloc(stride * height)
  let seed = 0x1234_5678
  for (let row = 0; row < height; row++) {
    for (let col = 1; col < stride; col++) {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      pixels[row * stride + col] = seed >>> 24
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // Eight-bit RGB, no alpha or interlacing.
  header[9] = 2
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}
