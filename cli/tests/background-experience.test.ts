import { resolveRunInteraction } from '../src/term/app/run-interaction.js'
import { expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { createSpinnerState, setSpinnerPhase, formatSpinnerLine } from '../src/term/spinner.js'
import { createBackgroundOutputState } from '../src/term/app/background-panel.js'
import stringWidth from 'string-width'
import { clipDisplayText } from '../src/render/format.js'

test('background task wait advertises release only and hides old usage', () => {
  const state = setSpinnerPhase(createSpinnerState(), 'executing', 'task_output')
  const text = stripAnsi(formatSpinnerLine(state, state.phaseStartedAt + 120000, { inputTokens: 100, outputTokens: 40 }, {
    interaction: resolveRunInteraction({ active: true, owner: state, blockingWaits: 1 }),
  }))
  expect(text).toContain('Waiting for task result')
  expect(text).toContain('to release wait')
  expect(text).not.toContain('esc twice to interrupt')
  expect(text).not.toContain('interrupt agent')
  expect(text).not.toContain('↑')
  expect(text).not.toContain('↓')
  expect(text).not.toContain('to background')
  expect(text).not.toContain('slow')
})
test('a wait on a known task names it and times the task, not the wait', () => {
  const state = setSpinnerPhase(createSpinnerState(), 'executing', 'task_output')
  // The wait started half a second ago; the task has run for 23 seconds.
  const text = stripAnsi(formatSpinnerLine(state, state.phaseStartedAt + 474, undefined, {
    interaction: resolveRunInteraction({ active: true, owner: state, blockingWaits: 1 }),
    awaitedTasks: { titles: ['clippy storages-common-cache'], elapsedMs: 23_000 },
  }))
  expect(text).toContain('Waiting on clippy storages-common-cache… (23.0s)')
  expect(text).not.toContain('474ms')
  expect(text).toContain('to release wait')
})

test('waits on several tasks are counted and timed by the longest', () => {
  const state = setSpinnerPhase(createSpinnerState(), 'executing', 'task_output')
  const text = stripAnsi(formatSpinnerLine(state, state.phaseStartedAt + 10, undefined, {
    interaction: resolveRunInteraction({ active: true, owner: state, blockingWaits: 2 }),
    awaitedTasks: { titles: ['build', 'bench'], elapsedMs: 673_000 },
  }))
  expect(text).toContain('Waiting on 2 tasks… (11m13s)')
})

test('a long task title is clipped so the release hint survives', () => {
  const state = setSpinnerPhase(createSpinnerState(), 'executing', 'task_output')
  const text = stripAnsi(formatSpinnerLine(state, state.phaseStartedAt + 10, undefined, {
    interaction: resolveRunInteraction({ active: true, owner: state, blockingWaits: 1 }),
    awaitedTasks: { titles: ['x'.repeat(200)], elapsedMs: 1_000 },
    columns: 100,
  }))
  expect(text).toContain('…')
  expect(text).toContain('to release wait')
})

test('the awaited task only renames a task wait, never an active run', () => {
  const state = setSpinnerPhase(createSpinnerState(), 'executing', 'bash')
  const text = stripAnsi(formatSpinnerLine(state, state.phaseStartedAt + 2_000, undefined, {
    interaction: resolveRunInteraction({ active: true, owner: state }),
    awaitedTasks: { titles: ['build'], elapsedMs: 600_000 },
  }))
  expect(text).not.toContain('Waiting on')
  expect(text).toContain('(2.0s')
})

test('command clipping respects grapheme width and background details retain full command', () => {
  const command = 'hello🙂'.repeat(80)
  expect(stringWidth(clipDisplayText(command, 12))).toBeLessThanOrEqual(12)
  expect(clipDisplayText('👨‍👩‍👧‍👦 hello', 3)).toBe('👨‍👩‍👧‍👦…')
  const state = createBackgroundOutputState({ task_id: 't', command, cwd: '/tmp', output_path: '/tmp/out', status: 'running', elapsed_ms: 10, exit_code: null, output_file_truncated: false, stopped_by_user: false }, 'output')
  expect(state.items[0]?.preview?.join('\n')).toContain(command)
  expect(state.items[0]?.preview?.join('\n')).toContain('Command')
})
