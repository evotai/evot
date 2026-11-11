import { describe, expect, test } from 'bun:test'
import { compactionToolName, toolActionLabel } from '../../../src/term/widgets/spinner.js'

describe('compaction spinner labels', () => {
  test('activity refines local phases without changing legacy labels', () => {
    expect(compactionToolName('local')).toBe('compact_local')
    expect(toolActionLabel(compactionToolName('local', 'waiting'))).toBe('Compacting · waiting for summary')
    expect(toolActionLabel(compactionToolName('local', 'generating'))).toBe('Compacting · generating summary')
    expect(compactionToolName('pruning')).toBe('compact')
    // Phases retired with provider-native compaction fall back to the generic label.
    expect(compactionToolName('remote', 'generating')).toBe('compact')
    expect(compactionToolName('local_fallback', 'generating')).toBe('compact')
  })

  test('shows the active compaction method', () => {
    expect(toolActionLabel('compact')).toBe('Compacting')
    expect(toolActionLabel('compact_local')).toBe('Compacting local')
  })
})
