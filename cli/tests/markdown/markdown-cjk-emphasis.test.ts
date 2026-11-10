import { describe, expect, test } from 'bun:test'
import type { Token, Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { lexRawMarkdownTokens } from '../../src/markdown/parse/marked.js'
import { renderMarkdown } from '../../src/render/markdown.js'

function inlineTokens(source: string): Token[] {
  const block = lexRawMarkdownTokens(source)[0] as Tokens.Paragraph
  return block.tokens ?? []
}

function render(source: string): string {
  return stripAnsi(renderMarkdown(source))
}

describe('CJK emphasis boundaries', () => {
  test.each(['。', '．', '.', '!', '！', '？', '?'])(
    'closes strong emphasis after %s before unspaced CJK prose',
    punctuation => {
      const body = `高度固定的季节性，值得排查${punctuation}`
      const source = `**${body}**这是后续说明。`
      const tokens = inlineTokens(source)
      expect(tokens[0]).toMatchObject({ type: 'strong', raw: `**${body}**`, text: body })
      expect(tokens[1]).toMatchObject({ type: 'text', text: '这是后续说明。' })
      expect(tokens.map(token => token.raw).join('')).toBe(source)
      expect(render(source)).toBe(`${body}这是后续说明。`)
    },
  )

  test('handles the screenshot paragraphs without leaking or merging bold spans', () => {
    const source = [
      '**在北京，每年都在秋季开始，持续一个月，仍然值得排查。**北京秋季的花期与这个时间段重叠。',
      '',
      '**你说已经排查，只是没有喷嚏，还是只是鼻塞？**这是判断的关键。',
      '',
      '- **如果只是没有喷嚏、眼痒**，仍需排查。',
      '- 普通列表内容。',
      '',
      '### 对这种每年可预测的情况',
      '',
      '**先确认适合的方案，再讨论下一步。**例如每年提前安排。',
    ].join('\n')
    const result = render(source)
    expect(result).not.toContain('**')
    expect(result).not.toContain('<!--')
    expect(result).toContain('排查。北京秋季')
    expect(result).toContain('鼻塞？这是判断的关键。')
    expect(result).toContain('### 对这种每年可预测的情况')
  })

  test.each(['*', '**', '***'])(
    'delegates %s delimiter runs to marked',
    delimiter => {
      const source = `${delimiter}重要。${delimiter}下一句`
      expect(render(source)).toBe('重要。下一句')
      expect(inlineTokens(source).map(token => token.raw).join('')).toBe(source)
    },
  )

  test('keeps nested emphasis and inline code tokens', () => {
    const source = '**先看 *重点* 和 `值。**下一项`，再确认。**下一句'
    const tokens = inlineTokens(source)
    expect(tokens[0]?.type).toBe('strong')
    const nested = (tokens[0] as Tokens.Strong).tokens
    expect(nested.some(token => token.type === 'em')).toBe(true)
    expect(nested.some(token => token.type === 'codespan' && token.text === '值。**下一项')).toBe(true)
    expect(render(source)).toBe('先看 重点 和 值。**下一项，再确认。下一句')
  })

  test('does not use delimiters in link destinations as closers', () => {
    const source = '**查看[链接](https://example.com/值。**下一项)，然后确认。**下一句'
    const tokens = inlineTokens(source)
    expect(tokens[0]).toMatchObject({ type: 'strong', raw: source.slice(0, -3) })
    expect((tokens[0] as Tokens.Strong).tokens.some(token => token.type === 'link')).toBe(true)
  })

  test('works inside headings, lists, quotes, and table cells', () => {
    const source = [
      '### **标题。**下一句',
      '',
      '- **列表。**下一句',
      '',
      '> **引用。**下一句',
      '',
      '| 内容 |',
      '| --- |',
      '| **单元格。**下一句 |',
    ].join('\n')
    const result = render(source)
    expect(result).not.toContain('**')
    for (const label of ['标题', '列表', '引用', '单元格']) {
      expect(result).toContain(`${label}。下一句`)
    }
  })

  test.each([
    '`**重要。**下一句`',
    '```text\n**重要。**下一句\n```',
    '    **重要。**下一句',
  ])('keeps code literal: %s', source => {
    expect(render(source)).toContain('**重要。**下一句')
  })

  test('keeps escaped delimiters literal', () => {
    expect(render('\\*\\*重要。\\*\\*下一句')).toBe('**重要。**下一句')
    expect(render('**先看。\\*\\*下一句，再确认。**结束')).toBe('先看。**下一句，再确认。结束')
  })

  test.each([
    '_重要。_下一句',
    '__重要。__下一句',
    '___重要。___下一句',
    '**重要。',
    '**重要。 **下一句',
    '** 重要。**下一句',
    '**important.**next',
    'word__important.__next',
  ])('does not repair unrelated or incomplete syntax: %s', source => {
    expect(render(source)).toBe(source)
  })

  test('streamed prefixes preserve source offsets and settle to the complete span', () => {
    const source = '**重点。**下一句和**另一点？**后续'
    for (let end = 1; end <= source.length; end++) {
      const prefix = source.slice(0, end)
      expect(lexRawMarkdownTokens(prefix).map(token => token.raw).join('')).toBe(prefix)
      expect(() => renderMarkdown(prefix, { streaming: true })).not.toThrow()
    }
    expect(render(source)).toBe('重点。下一句和另一点？后续')
  })
})
