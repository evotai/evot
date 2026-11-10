import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readOutputTail } from '../../../src/term/app/run/output-tail.js'

let dir = ''

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'evot-tail-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function write(name: string, content: string | Buffer): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

describe('readOutputTail', () => {
  test('a file inside the window is returned whole', () => {
    const path = write('small.txt', 'one\ntwo\nthree\n')
    expect(readOutputTail(path)).toBe('one\ntwo\nthree\n')
  })

  test('an empty file yields an empty string', () => {
    expect(readOutputTail(write('empty.txt', ''))).toBe('')
  })

  test('only the tail is read once the file exceeds the window', () => {
    // 40 bytes of 'a' lines then a marker: a 20-byte window can only reach the end.
    const path = write('big.txt', `${'a'.repeat(40)}\nlast line\n`)
    const tail = readOutputTail(path, 20)
    expect(tail).toBe('last line\n')
    expect(tail).not.toContain('aaa')
  })

  test('the leading partial line is dropped rather than shown as a fragment', () => {
    const path = write('partial.txt', 'first line is long\nsecond\nthird\n')
    // A window landing mid-'first line is long' must not emit its tail fragment.
    const tail = readOutputTail(path, 14)
    expect(tail).toBe('second\nthird\n')
  })

  test('a window with no newline returns what it has rather than nothing', () => {
    // One enormous line: there is no boundary to trim to, so the fragment is
    // better than an empty view.
    const path = write('oneline.txt', 'x'.repeat(100))
    expect(readOutputTail(path, 10)).toBe('x'.repeat(10))
  })

  test('a file exactly the window size keeps its first line', () => {
    const content = 'ab\ncd\n'
    const path = write('exact.txt', content)
    expect(readOutputTail(path, content.length)).toBe(content)
  })

  test('multi-byte characters inside the window survive intact', () => {
    const path = write('utf8.txt', 'héllo wörld ✓\n')
    expect(readOutputTail(path)).toBe('héllo wörld ✓\n')
  })

  test('trimming to a newline avoids splitting a multi-byte character', () => {
    // The window boundary lands inside the 3-byte '✓', which would decode as a
    // replacement character; dropping the partial first line removes it.
    const path = write('utf8-cut.txt', `${'✓'.repeat(10)}\nplain tail\n`)
    const tail = readOutputTail(path, 20)
    expect(tail).toBe('plain tail\n')
    expect(tail).not.toContain('\ufffd')
  })

  test('a missing file surfaces the error to the caller', () => {
    // The controller renders this as a message instead of crashing the panel.
    expect(() => readOutputTail(join(dir, 'nope.txt'))).toThrow()
  })
})
