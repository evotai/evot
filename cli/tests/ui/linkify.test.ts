import { describe, test, expect } from 'bun:test'
import { linkifyIssueRefs } from '../../src/ui/linkify.js'
import stripAnsi from 'strip-ansi'

describe('linkifyIssueRefs', () => {
  test('detects owner/repo#123 pattern', () => {
    const result = linkifyIssueRefs('see anthropics/claude-code#100')
    const plain = stripAnsi(result)
    expect(plain).toBe('see anthropics/claude-code#100')
  })

  test('handles multiple refs', () => {
    const result = stripAnsi(linkifyIssueRefs('fix foo/bar#1 and foo/bar#2'))
    expect(result).toBe('fix foo/bar#1 and foo/bar#2')
  })

  test('ignores bare #123 without repo', () => {
    const result = linkifyIssueRefs('issue #123')
    expect(result).toBe('issue #123')
  })

  test('ignores invalid repo names', () => {
    const result = linkifyIssueRefs('not/a/valid/repo#123')
    expect(result).toBe('not/a/valid/repo#123')
  })

  test('ignores # without number', () => {
    const result = linkifyIssueRefs('foo/bar#abc')
    expect(result).toBe('foo/bar#abc')
  })

  test('handles ref at start of string', () => {
    const plain = stripAnsi(linkifyIssueRefs('foo/bar#42 is fixed'))
    expect(plain).toBe('foo/bar#42 is fixed')
  })

  test('handles ref at end of string', () => {
    const plain = stripAnsi(linkifyIssueRefs('see foo/bar#42'))
    expect(plain).toBe('see foo/bar#42')
  })

  test('does not match when preceded by alphanumeric', () => {
    // When a valid ref is glued to a preceding word (no space/punctuation boundary)
    const result = linkifyIssueRefs('prefix.foo/bar#42')
    expect(result).toBe('prefix.foo/bar#42')
  })

  test('returns input unchanged when no refs', () => {
    const input = 'no issue refs here'
    expect(linkifyIssueRefs(input)).toBe(input)
  })

  test('ref without OSC 8 support is not colored (claudecode-style)', () => {
    // Without hyperlink support we leave the ref as plain text: there is no
    // clickable target, and coloring bare refs just adds noise.
    const prev = process.env.FORCE_HYPERLINK
    process.env.FORCE_HYPERLINK = '0'
    try {
      const result = linkifyIssueRefs('see foo/bar#42')
      expect(result).toBe('see foo/bar#42')
      expect(result).not.toContain('\x1b[')
    } finally {
      if (prev === undefined) delete process.env.FORCE_HYPERLINK
      else process.env.FORCE_HYPERLINK = prev
    }
  })
})
