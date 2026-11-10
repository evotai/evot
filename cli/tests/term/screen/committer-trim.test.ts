import { test, expect } from 'bun:test'
import { Committer, MAX_HISTORY_LINES } from '../../../src/term/screen/committer.js'
import type { OutputLine } from '../../../src/render/output.js'

function harness(expanded = false) {
  const compactLines: OutputLine[] = []
  const expandedLines: OutputLine[] = []
  let invalidations = 0
  const committer = new Committer({
    compactLines, expandedLines, isExpanded: () => expanded, columns: () => 80,
    logLines() {}, requestRender() {}, invalidateHistory() { invalidations++ },
  })
  return { committer, compactLines, expandedLines, invalidations: () => invalidations }
}

function rows(prefix: string, count: number): OutputLine[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, kind: 'tool_result' as const, text: `${prefix} ${i}` }))
}

test('history past the bound drops its oldest rows behind one notice and rebuilds the cache', () => {
  const { committer, compactLines, expandedLines, invalidations } = harness()
  committer.commit(rows('a', MAX_HISTORY_LINES))
  expect(compactLines).toHaveLength(MAX_HISTORY_LINES)
  expect(invalidations()).toBe(0)

  committer.commit(rows('b', 10))
  expect(compactLines.length).toBeLessThan(MAX_HISTORY_LINES)
  expect(compactLines[0]?.id).toBe('history-trimmed')
  expect(compactLines.at(-1)?.text).toBe('b 9')
  expect(expandedLines[0]?.id).toBe('history-trimmed')
  expect(invalidations()).toBe(1)

  // The next trim replaces the notice instead of stacking a second one.
  committer.commit(rows('c', MAX_HISTORY_LINES))
  expect(compactLines.filter(line => line.id === 'history-trimmed')).toHaveLength(1)
  expect(compactLines[0]?.id).toBe('history-trimmed')
  expect(compactLines.at(-1)?.text).toBe(`c ${MAX_HISTORY_LINES - 1}`)
})

test('the expanded view is bounded on its own, since it carries full tool output', () => {
  const { committer, compactLines, expandedLines } = harness()
  for (let i = 0; i < 30; i++) {
    committer.commitDual([{ id: `s-${i}`, kind: 'tool', text: `step ${i}` }], rows(`out${i}`, 1_000))
  }
  expect(compactLines).toHaveLength(30)
  expect(expandedLines.length).toBeLessThanOrEqual(MAX_HISTORY_LINES)
  expect(expandedLines[0]?.id).toBe('history-trimmed')
  expect(expandedLines.at(-1)?.text).toBe('out29 999')
})

test('a restored transcript is bounded too and never spreads into push', () => {
  const { committer, compactLines } = harness()
  committer.restore(rows('r', 200_000))
  expect(compactLines.length).toBeLessThanOrEqual(MAX_HISTORY_LINES)
  expect(compactLines.at(-1)?.text).toBe('r 199999')
})
