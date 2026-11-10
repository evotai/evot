/**
 * Streaming markdown stability: a code block's closing fence arrives one
 * character at a time. Without trimming, marked absorbs the partial fence
 * (a lone ` or ``) into the code token's text, so the block renders one line
 * too tall and then shrinks when the final backtick lands — a visible flicker.
 * lexMarkdownTokens trims that partial fence so the code text stays stable
 * across every streaming frame.
 */

import { describe, test, expect } from 'bun:test'
import { lexMarkdownTokens } from '../../src/markdown/parse/marked.js'
import type { Tokens } from 'marked'

function codeText(src: string): string | undefined {
  const tokens = lexMarkdownTokens(src)
  const code = tokens.find((t) => t.type === 'code') as Tokens.Code | undefined
  return code?.text
}

describe('lexMarkdownTokens streaming fence trim', () => {
  test('code text is identical across partial and complete closing fences', () => {
    const open = '```js\nconst x = 1'
    const oneBacktick = '```js\nconst x = 1\n`'
    const twoBacktick = '```js\nconst x = 1\n``'
    const complete = '```js\nconst x = 1\n```'

    expect(codeText(oneBacktick)).toBe('const x = 1')
    expect(codeText(twoBacktick)).toBe('const x = 1')
    expect(codeText(complete)).toBe('const x = 1')
    // Still-open block (no closing line yet) already renders as just content.
    expect(codeText(open)).toBe('const x = 1')
  })

  test('handles tilde fences too', () => {
    expect(codeText('~~~\ncode\n~')).toBe('code')
    expect(codeText('~~~\ncode\n~~')).toBe('code')
    expect(codeText('~~~\ncode\n~~~')).toBe('code')
  })

  test('does not trim a content line that merely ends in a backtick', () => {
    // The last line is real code, not a partial fence — must be preserved.
    expect(codeText('```js\nconst x = `t`')).toBe('const x = `t`')
  })

  test('trims a partial fence inside a list item code block', () => {
    const src = '- item\n\n  ```js\n  const x = 1\n  `'
    const tokens = lexMarkdownTokens(src)
    const list = tokens.find((t) => t.type === 'list') as Tokens.List | undefined
    expect(list).toBeDefined()
    const lastItem = list!.items[list!.items.length - 1]
    const code = lastItem?.tokens.find((t) => t.type === 'code') as Tokens.Code | undefined
    expect(code?.text).toBe('const x = 1')
  })

  test('leaves prose without code blocks unchanged', () => {
    const tokens = lexMarkdownTokens('# Title\n\nSome **bold** text.')
    const heading = tokens.find((t) => t.type === 'heading') as Tokens.Heading | undefined
    expect(heading?.text).toBe('Title')
  })
})
