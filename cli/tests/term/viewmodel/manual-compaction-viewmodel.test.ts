import { expect, test } from 'bun:test'
import { manualCompactionLines } from '../../../src/term/viewmodel/manual-compaction.js'
import { compactionOutcome } from '../../../src/native/contracts/results.js'
import fixture from '../../fixtures/contracts/native-results-legacy.json'

test('manual compaction retains expandable details, fallback and context warnings', () => {
  const outcome = compactionOutcome.read(fixture.compaction, '$')
  if (outcome.status !== 'compacted') throw new Error('expected fixture completion')
  const before = JSON.stringify(outcome)
  const lines = manualCompactionLines(outcome)
  expect(lines.compact.map(line => line.id)).toEqual(['sys-compact-label', 'sys-compact-result', 'sys-compact-fallback'])
  expect(lines.compact[1]?.text).toContain('ctrl+o')
  expect(lines.expanded.map(line => line.text).join('\n')).toContain('fixture')
  expect(JSON.stringify(outcome)).toBe(before)
  expect(manualCompactionLines(outcome)).toEqual(lines)
  const warning = manualCompactionLines({ ...outcome, tokens_after: 1000, context_window: 1000, used_fallback: false })
  expect(warning.compact.at(-1)?.kind).toBe('error')
  expect(warning.expanded.at(-1)).toEqual(warning.compact.at(-1))
  expect(warning.compact.some(line => line.id === 'sys-compact-fallback')).toBe(false)
})
