import fs from 'fs'
import path from 'path'

const IGNORE = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.next'])
const MAX_FILE_BYTES = 50 * 1024   // 50KB per file
const MAX_TOTAL_BYTES = 100 * 1024 // 100KB total

export interface TextBlock {
  type: 'text'
  text: string
}

export function loadFileBlocks(paths: string[]): TextBlock[] {
  if (paths.length === 0) return []

  const blocks: TextBlock[] = []
  let totalBytes = 0

  for (const p of paths) {
    const resolved = path.resolve(p)
    const stat = fs.statSync(resolved, { throwIfNoEntry: false })
    if (!stat) {
      throw new Error(`File not found: ${p}`)
    }

    let text: string
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved)
        .filter(e => !IGNORE.has(e))
        .sort()
        .slice(0, 200)
      text = `Directory listing of ${resolved}:\n${entries.join('\n')}`
    } else {
      // Binary detection: check first 512 bytes for null byte
      const probe = Buffer.alloc(512)
      const fd = fs.openSync(resolved, 'r')
      const bytesRead = fs.readSync(fd, probe, 0, 512, 0)
      fs.closeSync(fd)
      if (probe.subarray(0, bytesRead).includes(0)) {
        throw new Error(`Binary file not supported: ${p}`)
      }

      const raw = fs.readFileSync(resolved, 'utf-8')
      const rawBytes = Buffer.byteLength(raw)
      if (rawBytes > MAX_FILE_BYTES) {
        const lines = raw.split('\n')
        let bytes = 0
        let i = 0
        for (; i < lines.length; i++) {
          bytes += Buffer.byteLength(lines[i]) + 1
          if (bytes > MAX_FILE_BYTES) break
        }
        text = `Contents of ${resolved}:\n[truncated: ${rawBytes} bytes, showing first ${i} lines]\n\n${lines.slice(0, i).join('\n')}`
      } else {
        text = `Contents of ${resolved}:\n\n${raw}`
      }
    }

    const size = Buffer.byteLength(text)
    if (totalBytes + size > MAX_TOTAL_BYTES) {
      blocks.push({ type: 'text', text: 'Some attached files were omitted because the total context limit (100KB) was reached.' })
      break
    }
    blocks.push({ type: 'text', text })
    totalBytes += size
  }

  return blocks
}
