import { describe, test, expect } from 'bun:test'
import { needsContinuation } from '../../../src/term/input/continuation.js'

describe('needsContinuation', () => {
  test('returns false for plain text', () => {
    expect(needsContinuation('hello world')).toBe(false)
  })

  test('returns true for trailing backslash', () => {
    expect(needsContinuation('line one\\')).toBe(true)
  })

  test('returns false when backslash is not trailing', () => {
    expect(needsContinuation('path\\to\\file')).toBe(false)
  })

  test('returns true for unclosed triple-backtick fence', () => {
    expect(needsContinuation('```js\nconst x = 1')).toBe(true)
  })

  test('returns false for closed triple-backtick fence', () => {
    expect(needsContinuation('```js\nconst x = 1\n```')).toBe(false)
  })

  test('returns true for re-opened fence', () => {
    expect(needsContinuation('```\ncode\n```\n```\nmore')).toBe(true)
  })

  test('returns false for empty input', () => {
    expect(needsContinuation('')).toBe(false)
  })

  test('returns true for trailing backslash on last line of multiline', () => {
    expect(needsContinuation('line1\nline2\\')).toBe(true)
  })

  test('returns false for backslash on non-last line', () => {
    expect(needsContinuation('line1\\\nline2')).toBe(false)
  })
})
