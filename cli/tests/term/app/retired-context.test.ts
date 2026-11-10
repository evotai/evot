import { expect, test } from 'bun:test'
import { decodeQueryEvent } from '../../../src/native/contracts/query-event.js'
import { createInitialState } from '../../../src/term/app/run/state.js'
import { createStreamMachineState, reduceRunEvent } from '../../../src/term/app/run/stream.js'
import { createSpinnerState } from '../../../src/term/widgets/spinner.js'
import { formatLogPaths, logAnalysisPrompt } from '../../../src/term/command-handlers.js'
import fixtures from '../../fixtures/contracts/run-payloads.json'
import rich from '../../fixtures/contracts/run-payloads-rich.json'

const retired = [...fixtures, ...rich].filter(fixture =>
  fixture.kind === 'context_pruned' || fixture.kind === 'tool_calls_reviewed')

test('historical pruning events decode but never affect the live session or render notices', () => {
  expect(retired.length).toBeGreaterThan(0)
  for (const fixture of retired) {
    const event = decodeQueryEvent(JSON.stringify({
      event_id: 'old', run_id: 'run', session_id: 'session', turn: 1,
      created_at: '2026-01-01T00:00:00Z', ...fixture,
    }))
    const initial = createStreamMachineState(createInitialState('model', '/tmp'), createSpinnerState())
    const update = reduceRunEvent(initial, event, { termRows: 24 })
    expect(update.state.appState).toEqual(initial.appState)
    expect(update.state.spinnerState).toEqual(initial.spinnerState)
    expect(update.commitLines).toEqual([])
    expect(update.noticeLines).toEqual([])
    expect(update.writeLines).toEqual([])
  }
})

test('/log still reports screen and renderer logs without retired side-model traces', () => {
  expect(formatLogPaths(null)).toBeNull()
  expect(formatLogPaths('/tmp/s.screen.log', '/tmp/renderer', 'render summary'))
    .toBe('  Log: /tmp/s.screen.log\n  Renderer run: /tmp/renderer\nrender summary')
  const prompt = logAnalysisPrompt('/tmp/s.screen.log')
  expect(prompt).toContain('Screen log file to analyze:\n/tmp/s.screen.log')
  expect(prompt).toContain('Do not modify any files')
  expect(prompt).not.toContain('judge-trace')
})
