import { describe, test, expect } from 'bun:test'
import { loadFileBlocks } from '../../src/headless/file-loader.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evot-fl-'))
}

describe('loadFileBlocks', () => {
  test('returns empty for no paths', () => {
    expect(loadFileBlocks([])).toEqual([])
  })

  test('loads text file', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'hello.txt')
    fs.writeFileSync(file, 'hello world')
    const blocks = loadFileBlocks([file])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('text')
    expect(blocks[0].text).toContain('hello world')
    expect(blocks[0].text).toContain('Contents of')
    fs.rmSync(dir, { recursive: true })
  })

  test('loads directory listing', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'a.ts'), '')
    fs.writeFileSync(path.join(dir, 'b.ts'), '')
    fs.mkdirSync(path.join(dir, '.git'))
    fs.mkdirSync(path.join(dir, 'node_modules'))
    const blocks = loadFileBlocks([dir])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toContain('Directory listing of')
    expect(blocks[0].text).toContain('a.ts')
    expect(blocks[0].text).toContain('b.ts')
    expect(blocks[0].text).not.toContain('.git')
    expect(blocks[0].text).not.toContain('node_modules')
    fs.rmSync(dir, { recursive: true })
  })

  test('throws on file not found', () => {
    expect(() => loadFileBlocks(['/nonexistent/path/xyz'])).toThrow('File not found')
  })

  test('throws on binary file', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'bin.dat')
    const buf = Buffer.alloc(64)
    buf[10] = 0 // null byte
    buf[0] = 0x89 // some non-zero bytes around it
    fs.writeFileSync(file, buf)
    expect(() => loadFileBlocks([file])).toThrow('Binary file not supported')
    fs.rmSync(dir, { recursive: true })
  })

  test('truncates large files', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'big.txt')
    // 60KB of text, exceeds 50KB limit
    const line = 'x'.repeat(100) + '\n'
    const content = line.repeat(700)
    fs.writeFileSync(file, content)
    const blocks = loadFileBlocks([file])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toContain('[truncated:')
    expect(Buffer.byteLength(blocks[0].text)).toBeLessThan(60 * 1024)
    fs.rmSync(dir, { recursive: true })
  })

  test('respects total size limit across files', () => {
    const dir = tmpDir()
    // Create 3 files of ~40KB each — total would exceed 100KB
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      fs.writeFileSync(path.join(dir, name), 'y'.repeat(40 * 1024))
    }
    const paths = ['a.txt', 'b.txt', 'c.txt'].map(n => path.join(dir, n))
    const blocks = loadFileBlocks(paths)
    const hasOmitted = blocks.some(b => b.text.includes('omitted'))
    expect(hasOmitted).toBe(true)
    fs.rmSync(dir, { recursive: true })
  })

  test('loads multiple files', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const a = 1')
    fs.writeFileSync(path.join(dir, 'b.ts'), 'const b = 2')
    const blocks = loadFileBlocks([path.join(dir, 'a.ts'), path.join(dir, 'b.ts')])
    expect(blocks).toHaveLength(2)
    expect(blocks[0].text).toContain('const a = 1')
    expect(blocks[1].text).toContain('const b = 2')
    fs.rmSync(dir, { recursive: true })
  })
})
