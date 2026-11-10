import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import {
  escapePipesInTableInlineCode,
  escapePipesInTableRow,
  looksLikeTableRow,
} from '../../src/markdown/normalize/tables.js'
import { renderMarkdown } from '../../src/render/markdown.js'

describe('escapePipesInTableInlineCode', () => {
  test('escapes pipe inside inline code on a table row', () => {
    const row =
      '| **Hybrid Hash Join** | hybrid | API exposes one `HashJoin`, internal `InMemory | Grace`, LLM-transparent |'
    expect(escapePipesInTableRow(row)).toBe(
      '| **Hybrid Hash Join** | hybrid | API exposes one `HashJoin`, internal `InMemory \\| Grace`, LLM-transparent |',
    )
  })

  test('leaves already-escaped pipes alone', () => {
    const row = '| a | `InMemory \\| Grace` |'
    expect(escapePipesInTableRow(row)).toBe(row)
  })

  test('does not touch prose or code fences', () => {
    const prose = 'Use `a | b` in prose and leave it.'
    expect(escapePipesInTableInlineCode(prose)).toBe(prose)

    const fence = ['```ts', 'const x = a | b', '```'].join('\n')
    expect(escapePipesInTableInlineCode(fence)).toBe(fence)
  })

  test('does not touch separator rows', () => {
    const sep = '|---|-----------|----------------|'
    expect(escapePipesInTableRow(sep)).toBe(sep)
  })

  test('looksLikeTableRow requires pipe table shape', () => {
    expect(looksLikeTableRow('| a | b |')).toBe(true)
    expect(looksLikeTableRow('a | b | c')).toBe(true)
    expect(looksLikeTableRow('just `a | b` text')).toBe(false)
  })
})

describe('renderMarkdown table cell pipes', () => {
  test('keeps InMemory | Grace intact inside a table cell', () => {
    const md = [
      '| Mechanism | Implication for db0 |',
      '|---|---|',
      '| **Hybrid Hash Join** | API exposes one `HashJoin`, internal `InMemory | Grace`, LLM-transparent |',
    ].join('\n')

    const result = stripAnsi(renderMarkdown(md))
    expect(result).toContain('InMemory')
    expect(result).toContain('Grace')
    // Must not truncate the cell at the bare pipe; both halves stay in the table.
    expect(result).not.toMatch(/internal `InMemory\s*$/m)
    expect(result).toMatch(/InMemory[\s\S]*Grace/)
  })
})
