/**
 * Tests for paste reference protocol.
 */

import { describe, test, expect } from 'bun:test'
import {
  formatPastedTextRef,
  formatImageRef,
  parsePasteRefs,
  expandPasteRefs,
  deleteRefBackspace,
  shouldCollapse,
  cleanPastedText,
  resolveHistoryText,
  resolveSubmitText,
} from '../src/term/input/paste_refs.js'

// ---------------------------------------------------------------------------
// formatPastedTextRef
// ---------------------------------------------------------------------------

describe('formatPastedTextRef', () => {
  test('0 lines → no line count', () => {
    expect(formatPastedTextRef(1, 0)).toBe('[Pasted text #1]')
  })

  test('negative lines → no line count', () => {
    expect(formatPastedTextRef(2, -1)).toBe('[Pasted text #2]')
  })

  test('positive lines → includes line count', () => {
    expect(formatPastedTextRef(1, 10)).toBe('[Pasted text #1 +10 lines]')
  })

  test('1 line → +1 lines', () => {
    expect(formatPastedTextRef(3, 1)).toBe('[Pasted text #3 +1 lines]')
  })
})

// ---------------------------------------------------------------------------
// parsePasteRefs
// ---------------------------------------------------------------------------

describe('parsePasteRefs', () => {
  test('no refs → empty array', () => {
    expect(parsePasteRefs('hello world')).toEqual([])
  })

  test('single ref without line count', () => {
    const refs = parsePasteRefs('hello [Pasted text #1] world')
    expect(refs).toEqual([{
      id: 1,
      start: 6,
      end: 22,
      match: '[Pasted text #1]',
      type: 'text',
    }])
  })

  test('single ref with line count', () => {
    const refs = parsePasteRefs('hello [Pasted text #2 +10 lines] world')
    expect(refs).toEqual([{
      id: 2,
      start: 6,
      end: 32,
      match: '[Pasted text #2 +10 lines]',
      type: 'text',
    }])
  })

  test('multiple refs', () => {
    const text = '[Pasted text #1] and [Pasted text #2 +5 lines]'
    const refs = parsePasteRefs(text)
    expect(refs).toHaveLength(2)
    expect(refs[0]!.id).toBe(1)
    expect(refs[1]!.id).toBe(2)
  })

  test('ref at start of string', () => {
    const refs = parsePasteRefs('[Pasted text #1]')
    expect(refs[0]!.start).toBe(0)
  })

  test('ref at end of string', () => {
    const text = 'hello [Pasted text #1]'
    const refs = parsePasteRefs(text)
    expect(refs[0]!.end).toBe(text.length)
  })
})

// ---------------------------------------------------------------------------
// expandPasteRefs
// ---------------------------------------------------------------------------

describe('expandPasteRefs', () => {
  test('expands ref with stored content', () => {
    const store = new Map([[1, 'line1\nline2\nline3']])
    const result = expandPasteRefs('before [Pasted text #1 +3 lines] after', store)
    expect(result).toBe('before line1\nline2\nline3 after')
  })

  test('missing ref left as-is', () => {
    const store = new Map<number, string>()
    const text = 'hello [Pasted text #99] world'
    expect(expandPasteRefs(text, store)).toBe(text)
  })

  test('multiple refs expanded correctly', () => {
    const store = new Map([[1, 'AAA'], [2, 'BBB']])
    const result = expandPasteRefs('[Pasted text #1] and [Pasted text #2]', store)
    expect(result).toBe('AAA and BBB')
  })

  test('only matching refs expanded', () => {
    const store = new Map([[1, 'AAA']])
    const result = expandPasteRefs('[Pasted text #1] and [Pasted text #2]', store)
    expect(result).toBe('AAA and [Pasted text #2]')
  })
})

// ---------------------------------------------------------------------------
// deleteRefBackspace
// ---------------------------------------------------------------------------

describe('deleteRefBackspace', () => {
  const line = 'hello [Pasted text #1 +5 lines] end'
  const refs = parsePasteRefs(line)
  // ref at start=6, end=31

  test('cursor at ref end → delete entire ref', () => {
    const result = deleteRefBackspace(line, 31, refs)
    expect(result).toEqual({
      newLine: 'hello  end',
      newCursorCol: 6,
    })
  })

  test('cursor not at any ref boundary → null', () => {
    expect(deleteRefBackspace(line, 3, refs)).toBeNull()
  })

  test('cursor at ref start → null (normal backspace)', () => {
    expect(deleteRefBackspace(line, 6, refs)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// shouldCollapse
// ---------------------------------------------------------------------------

describe('shouldCollapse', () => {
  test('short single line → false', () => {
    expect(shouldCollapse('hello')).toBe(false)
  })

  test('2 lines → false (at threshold)', () => {
    expect(shouldCollapse('line1\nline2')).toBe(false)
  })

  test('3 newlines → true (exceeds line threshold)', () => {
    expect(shouldCollapse('a\nb\nc\nd')).toBe(true)
  })

  test('long single line → true (exceeds char threshold)', () => {
    expect(shouldCollapse('x'.repeat(801))).toBe(true)
  })

  test('exactly 800 chars → false', () => {
    expect(shouldCollapse('x'.repeat(800))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// cleanPastedText
// ---------------------------------------------------------------------------

describe('cleanPastedText', () => {
  test('strips ANSI escape codes', () => {
    expect(cleanPastedText('\x1b[31mhello\x1b[0m')).toBe('hello')
  })

  test('normalizes CRLF to LF', () => {
    expect(cleanPastedText('a\r\nb')).toBe('a\nb')
  })

  test('normalizes CR to LF', () => {
    expect(cleanPastedText('a\rb')).toBe('a\nb')
  })

  test('converts tabs to 4 spaces', () => {
    expect(cleanPastedText('\thello')).toBe('    hello')
  })

  test('combined cleanup', () => {
    expect(cleanPastedText('\x1b[32m\thello\r\nworld\x1b[0m'))
      .toBe('    hello\nworld')
  })

  test('plain text unchanged', () => {
    expect(cleanPastedText('hello world')).toBe('hello world')
  })
})

// ---------------------------------------------------------------------------
// formatImageRef
// ---------------------------------------------------------------------------

describe('formatImageRef', () => {
  test('formats image ref', () => {
    expect(formatImageRef(1)).toBe('[Image #1]')
  })

  test('formats image ref with higher id', () => {
    expect(formatImageRef(42)).toBe('[Image #42]')
  })
})

// ---------------------------------------------------------------------------
// parsePasteRefs — Image refs
// ---------------------------------------------------------------------------

describe('parsePasteRefs — image refs', () => {
  test('parses image ref', () => {
    const refs = parsePasteRefs('hello [Image #1] world')
    expect(refs).toEqual([{
      id: 1,
      start: 6,
      end: 16,
      match: '[Image #1]',
      type: 'image',
    }])
  })

  test('parses mixed text and image refs', () => {
    const text = '[Pasted text #1] and [Image #2]'
    const refs = parsePasteRefs(text)
    expect(refs).toHaveLength(2)
    expect(refs[0]!.type).toBe('text')
    expect(refs[0]!.id).toBe(1)
    expect(refs[1]!.type).toBe('image')
    expect(refs[1]!.id).toBe(2)
  })

  test('text refs have type text', () => {
    const refs = parsePasteRefs('[Pasted text #1 +5 lines]')
    expect(refs[0]!.type).toBe('text')
  })

  test('multiple image refs', () => {
    const refs = parsePasteRefs('[Image #1] [Image #2]')
    expect(refs).toHaveLength(2)
    expect(refs[0]!.id).toBe(1)
    expect(refs[1]!.id).toBe(2)
    expect(refs[0]!.type).toBe('image')
    expect(refs[1]!.type).toBe('image')
  })
})

// ---------------------------------------------------------------------------
// expandPasteRefs — skips image refs
// ---------------------------------------------------------------------------

describe('expandPasteRefs — image refs', () => {
  test('image refs are not expanded', () => {
    const store = new Map([[1, 'should not appear']])
    const text = 'hello [Image #1] world'
    expect(expandPasteRefs(text, store)).toBe(text)
  })

  test('text refs expanded, image refs left intact', () => {
    const store = new Map([[1, 'expanded text']])
    const text = '[Pasted text #1] and [Image #2]'
    expect(expandPasteRefs(text, store)).toBe('expanded text and [Image #2]')
  })
})

// ---------------------------------------------------------------------------
// cursor/delete/skip work with image refs
// ---------------------------------------------------------------------------

describe('cursor operations with image refs', () => {
  const text = 'hello [Image #1] end'
  const refs = parsePasteRefs(text)

  test('deleteRefBackspace at image ref end → delete entire ref', () => {
    const result = deleteRefBackspace(text, 16, refs)
    expect(result).toEqual({
      newLine: 'hello  end',
      newCursorCol: 6,
    })
  })

})

// ---------------------------------------------------------------------------
// resolveHistoryText
// ---------------------------------------------------------------------------

describe('resolveHistoryText', () => {
  test('persists expanded paste content instead of an ephemeral marker', () => {
    const chunks = new Map([[1, 'line one\nline two\nline three']])
    expect(resolveHistoryText('prefix [Pasted text #1 +2 lines] suffix', chunks))
      .toBe('prefix line one\nline two\nline three suffix')
  })

  test('keeps image refs alongside expanded text for history recall', () => {
    const chunks = new Map([[1, 'pasted content']])
    expect(resolveHistoryText('[Pasted text #1] [Image #2]', chunks))
      .toBe('pasted content [Image #2]')
  })

  test('keeps image-only history entries', () => {
    expect(resolveHistoryText('[Image #1]', new Map())).toBe('[Image #1]')
  })
})

// ---------------------------------------------------------------------------
// resolveSubmitText
// ---------------------------------------------------------------------------

describe('resolveSubmitText', () => {
  test('no paste refs, no images → returns text as-is', () => {
    const chunks = new Map<number, string>()
    expect(resolveSubmitText('hello world', chunks, null)).toBe('hello world')
  })

  test('expands paste ref when no images', () => {
    const chunks = new Map([[1, 'line1\nline2\nline3']])
    expect(resolveSubmitText('[Pasted text #1 +3 lines]', chunks, null))
      .toBe('line1\nline2\nline3')
  })

  test('expands paste refs and strips resolved image refs', () => {
    const chunks = new Map([[1, 'pasted content']])
    const resolvedIds = new Set([2])
    expect(resolveSubmitText('[Pasted text #1] [Image #2]', chunks, resolvedIds))
      .toBe('pasted content')
  })

  test('keeps unresolved image refs intact', () => {
    const chunks = new Map([[1, 'pasted content']])
    const resolvedIds = new Set<number>() // empty — image #2 not resolved
    expect(resolveSubmitText('[Pasted text #1] [Image #2]', chunks, resolvedIds))
      .toBe('pasted content [Image #2]')
  })

  test('expands paste refs even with null resolvedImageIds', () => {
    const chunks = new Map([[1, 'actual text']])
    expect(resolveSubmitText('prefix [Pasted text #1] suffix', chunks, null))
      .toBe('prefix actual text suffix')
  })

  test('missing paste ref left as-is', () => {
    const chunks = new Map<number, string>()
    expect(resolveSubmitText('[Pasted text #99]', chunks, null))
      .toBe('[Pasted text #99]')
  })

  test('text-only with paste refs, no images → paste refs expanded (regression)', () => {
    // This is the exact scenario from the bug: text paste without images.
    // The old code used getDisplayText() which left [Pasted text #N] placeholders.
    const chunks = new Map([[3, 'fn main() {\n    println!("hello");\n}']])
    expect(resolveSubmitText('[Pasted text #3 +3 lines]', chunks, null))
      .toBe('fn main() {\n    println!("hello");\n}')
  })
})
