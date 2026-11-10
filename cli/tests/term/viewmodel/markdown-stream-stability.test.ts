import { describe, expect, test } from 'bun:test'
import { buildAssistantLines } from '../../../src/render/output.js'
import { buildOutputBlocks } from '../../../src/term/viewmodel/output.js'
import { blocksToLines } from '../../../src/term/viewmodel/types.js'
import { updateLiveHeight } from '../../../src/term/viewmodel/live-height.js'
import { renderMarkdown } from '../../../src/render/markdown.js'
import { withColumns } from '../../helpers/stdout-columns.js'
import stripAnsi from 'strip-ansi'

function renderedHeight(markdown: string): number {
  return blocksToLines(
    buildOutputBlocks(buildAssistantLines(markdown), { columns: 40 }),
  ).length
}

describe('streaming markdown footer stability', () => {
  test('real markdown reparses may shrink but guarded footer height never does', () => {
    const samples = [
      '1. first\n2. second\n3. third',
      'Code:\n\n```ts\nconst x = 1\n```\n\nDone.',
      'Code:\n\n~~~~ts\nconst x = 1\n~~~~\n\nDone.',
      'Heading with glued fence```ts\nconst x = 1\n```\n\nDone.',
      '| Name | Value |\n| --- | --- |\n| a | short |\n| b | a much longer value |',
    ]

    let sawParserShrink = false
    for (const sample of samples) {
      let previousRendered = 0
      let maxHeight = 0
      let previousGuarded = 0
      for (let index = 1; index <= sample.length; index++) {
        const current = renderedHeight(sample.slice(0, index))
        if (current < previousRendered) sawParserShrink = true
        previousRendered = current

        const guarded = updateLiveHeight(maxHeight, current, true)
        maxHeight = guarded.maxHeight
        const footerRow = current + guarded.padding
        expect(footerRow).toBeGreaterThanOrEqual(previousGuarded)
        previousGuarded = footerRow
      }
    }
    expect(sawParserShrink).toBe(true)
  })

  test('renders and reflows a trailing table during streaming like pi', () => {
    const restore = withColumns(184)
    try {
      const prefix = [
        'Benchmark results:',
        '',
        '| Query | db0 (ms) | DuckDB (ms) | DuckDB/db0 |',
        '|---|---:|---:|---:|',
        '| Q01 | 90.55 | 106.07 | 1.171× |',
      ].join('\n')
      const grown = [
        prefix,
        '| Q15 | 25.88 | 121.15 | 4.682× |',
        '| Q23 | 8,600.92 | 11,359.96 | 1.321× |',
        '| **Total** | **27,269.08** | **44,034.29** | **1.615×** |',
      ].join('\n')

      const first = stripAnsi(renderMarkdown(prefix, { streaming: true }))
      expect(first).toContain('Benchmark results:')
      expect(first).toContain('┌')
      expect(first).toContain('Q01')
      expect(first).not.toContain('Q15')

      const streaming = stripAnsi(renderMarkdown(grown, { streaming: true }))
      expect(streaming).toContain('┌')
      expect(streaming).toContain('Q15')
      expect(streaming).toContain('27,269.08')
      expect(streaming).not.toContain('…')

      const final = stripAnsi(renderMarkdown(grown))
      expect(streaming).toBe(final)
    } finally {
      restore()
    }
  })

  test('streaming does not hide valid numeric or fence-looking text', () => {
    expect(renderedHeight('Version\n2026')).toBeGreaterThan(renderedHeight('Version\n'))
    expect(renderedHeight('Code:\n\n```ts\nconst x = 1\n`')).toBeGreaterThan(0)
  })
})
