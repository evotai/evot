import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { HistoryManager } from '../../src/session/history.js'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let tempDir: string
let historyPath: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'evot-history-test-'))
  historyPath = join(tempDir, 'history')
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('HistoryManager', () => {
  test('load returns empty array when file does not exist', () => {
    const hm = new HistoryManager(historyPath, { explicitPath: true })
    expect(hm.load()).toEqual([])
  })

  test('append + load round-trip', () => {
    const hm = new HistoryManager(historyPath, { explicitPath: true })
    hm.append('hello')
    hm.append('world')
    expect(hm.load()).toEqual(['hello', 'world'])
  })

  test('skips consecutive duplicates', () => {
    const hm = new HistoryManager(historyPath, { explicitPath: true })
    hm.append('hello')
    hm.append('hello')
    hm.append('hello')
    expect(hm.load()).toEqual(['hello'])
  })

  test('allows non-consecutive duplicates', () => {
    const hm = new HistoryManager(historyPath, { explicitPath: true })
    hm.append('a')
    hm.append('b')
    hm.append('a')
    expect(hm.load()).toEqual(['a', 'b', 'a'])
  })

  test('skips empty and whitespace-only entries', () => {
    const hm = new HistoryManager(historyPath, { explicitPath: true })
    hm.append('')
    hm.append('  ')
    hm.append('real')
    expect(hm.load()).toEqual(['real'])
  })

  test('trims entries', () => {
    const hm = new HistoryManager(historyPath, { explicitPath: true })
    hm.append('  hello  ')
    expect(hm.load()).toEqual(['hello'])
  })

  test('respects limit parameter', () => {
    const hm = new HistoryManager(historyPath, { explicitPath: true })
    for (let i = 0; i < 10; i++) {
      hm.append(`entry-${i}`)
    }
    const last3 = hm.load(3)
    expect(last3).toEqual(['entry-7', 'entry-8', 'entry-9'])
  })

  test('persists across instances', () => {
    const hm1 = new HistoryManager(historyPath, { explicitPath: true })
    hm1.append('from-first')

    const hm2 = new HistoryManager(historyPath, { explicitPath: true })
    expect(hm2.load()).toEqual(['from-first'])
    hm2.append('from-second')

    const hm3 = new HistoryManager(historyPath, { explicitPath: true })
    expect(hm3.load()).toEqual(['from-first', 'from-second'])
  })

  test('writes with newline-delimited format', () => {
    const hm = new HistoryManager(historyPath, { explicitPath: true })
    hm.append('one')
    hm.append('two')
    const raw = readFileSync(historyPath, 'utf-8')
    expect(raw).toBe('one\ntwo\n')
  })

  test('preserves multi-line entries via escaping', () => {
    const hm = new HistoryManager(historyPath, { explicitPath: true })
    hm.append('line1\nline2\nline3')
    hm.append('single')

    const hm2 = new HistoryManager(historyPath, { explicitPath: true })
    const entries = hm2.load()
    expect(entries).toEqual(['line1\nline2\nline3', 'single'])
  })

  test('escapes backslashes in entries', () => {
    const hm = new HistoryManager(historyPath, { explicitPath: true })
    hm.append('path\\to\\file')

    const hm2 = new HistoryManager(historyPath, { explicitPath: true })
    expect(hm2.load()).toEqual(['path\\to\\file'])
  })

  test('handles entry with both newlines and backslashes', () => {
    const hm = new HistoryManager(historyPath, { explicitPath: true })
    hm.append('first\\nline\nsecond line')

    const hm2 = new HistoryManager(historyPath, { explicitPath: true })
    expect(hm2.load()).toEqual(['first\\nline\nsecond line'])
  })
})
