import { describe, expect, test } from 'bun:test'
import { compactionToolName, toolActionLabel } from '../src/term/spinner.js'

describe('compaction spinner labels', () => {
  test('activity refines local phases without changing legacy labels', () => {
    expect(compactionToolName('local')).toBe('compact_local')
    expect(compactionToolName('local_fallback')).toBe('compact_local_fallback')
    expect(toolActionLabel(compactionToolName('local', 'waiting'))).toBe('Compacting · waiting for summary')
    expect(toolActionLabel(compactionToolName('local', 'generating'))).toBe('Compacting · generating summary')
    expect(compactionToolName('local_fallback', 'generating')).toBe('compact_generating')
    expect(compactionToolName('remote', 'generating')).toBe('compact_remote')
    expect(compactionToolName('pruning')).toBe('compact')
  })

  test('shows the active compaction method', () => {
    expect(toolActionLabel('compact')).toBe('Compacting')
    expect(toolActionLabel('compact_remote')).toBe('Compacting remote')
    expect(toolActionLabel('compact_local')).toBe('Compacting local')
    expect(toolActionLabel('compact_local_fallback')).toBe('Compacting local fallback')
  })
})
