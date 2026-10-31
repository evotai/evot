import { expect, test } from 'bun:test'
import { activeWork, commandLabel, outputTail } from '../src/term/app/suggestion/activities.js'
import { IDLE_WORKFLOW, SuggestionContext } from '../src/term/app/suggestion/context.js'
import { PromptSuggestion } from '../src/term/app/suggestion/controller.js'
import type { BackgroundProcess } from '../src/native/contracts/results.js'
import type { LoopSnapshot } from '../src/loop/controller.js'

const task = (overrides: Partial<BackgroundProcess> = {}): BackgroundProcess => ({
  task_id: 'auth-tests', description: 'Run focused authentication tests', command: 'cargo test -p auth',
  cwd: '/private/path', output_path: '/private/output', status: 'running', exit_code: null,
  elapsed_ms: 125_000, quiet_for_ms: 62_000, output_file_truncated: false, stopped_by_user: false, ...overrides,
})
const loop = (overrides: Partial<LoopSnapshot> = {}): LoopSnapshot => ({
  active: true, mode: { kind: 'fixed', intervalMs: 900_000 },
  task: { label: 'Monitor authentication checks', prompt: 'DO_NOT_SEND_LOOP_INTERNAL_PROMPT' },
  startedAt: 1000, nextFireAt: 901_000, reason: 'Waiting for a new CI result', tick: 3,
  noopStreak: 2, streakStartedAt: 1000, ...overrides,
})

test('only live tasks contribute bounded purposes, commands and timing, never paths', () => {
  const facts = activeWork([task(), task({ task_id: 'done', status: 'completed' }), task({ task_id: 'killed', status: 'killed' })], null, false)
  expect(facts).toEqual([{ kind: 'background', id: 'auth-tests', goal: 'Run focused authentication tests', command: 'cargo test -p auth', phase: 'running', elapsed_minutes: 2, quiet_minutes: 1 }])
  expect(JSON.stringify(facts)).not.toMatch(/private/)
  expect(activeWork([task({ description: undefined, quiet_for_ms: undefined })], null, false)[0]).not.toHaveProperty('goal')
  expect(activeWork([task({ description: 'x'.repeat(500) })], null, false)[0]?.goal?.length).toBe(120)
  expect(activeWork(Array.from({ length: 100 }, (_, i) => task({ task_id: String(i) })), loop(), false)).toHaveLength(7)
})

test('a silent task carries its command and quiet time but no tail; a chatty one a bounded tail', () => {
  // Old addons omit recent_output entirely; a compile has none yet.
  const silent = activeWork([task({ command: 'cargo build --release', recent_output: undefined })], null, false)[0]
  expect(silent).toMatchObject({ command: 'cargo build --release', quiet_minutes: 1 })
  expect(silent).not.toHaveProperty('output_tail')
  expect(activeWork([task({ recent_output: [] })], null, false)[0]).not.toHaveProperty('output_tail')
  const lines = Array.from({ length: 12 }, (_, i) => `[step ${i}] ok\t`)
  const chatty = activeWork([task({ recent_output: lines })], null, false)[0]
  expect(chatty?.output_tail).toEqual(lines.slice(-8).map(line => line.trim()))
  expect(outputTail(['', '   ', 'x'.repeat(500)])).toEqual(['x'.repeat(160)])
})

test('command label keeps the head of a heredoc script, since the body is the plan', () => {
  expect(commandLabel("python3 - <<'EOF'\n\nimport os\n  print(os.environ)\nEOF")).toBe("python3 - <<'EOF'\nimport os\nprint(os.environ)\nEOF")
  expect(commandLabel('\n\n  make check  \n')).toBe('make check')
  expect(commandLabel('   \n')).toBeUndefined()
  expect(commandLabel('c'.repeat(1000))?.length).toBe(600)
  expect(commandLabel(Array.from({ length: 30 }, (_, i) => `step ${i}`).join('\n'))?.split('\n')).toHaveLength(12)
  expect(commandLabel('a\u0007b')).toBe('a b')
})

test('loop phase, goal, cadence and wait reason reflect the controller rather than historical messages', () => {
  const snapshot = loop()
  expect(activeWork([], snapshot, false)).toEqual([{
    kind: 'loop', id: 'loop:1000', goal: 'Monitor authentication checks', phase: 'waiting',
    cadence: 'fixed', interval_ms: 900_000, next_check_at: new Date(901_000).toISOString(),
    iteration: 3, wait_reason: 'Waiting for a new CI result', unchanged_iterations: 2,
  }])
  expect(activeWork([], loop({ nextFireAt: null, mode: { kind: 'dynamic' } }), true)[0]).toMatchObject({ phase: 'running', cadence: 'dynamic' })
  expect(activeWork([], loop({ active: false }), false)).toEqual([])
  expect(JSON.stringify(activeWork([], snapshot, false))).not.toContain('DO_NOT_SEND')
  const source = new SuggestionContext()
  source.restore([{ type: 'user', text: 'Old watcher is running' }])
  expect(source.snapshot().workflow.runtime.activities).toBeUndefined()
})

test('precise runtime context reaches requests and cache keys without extra sampling while a batch is visible', async () => {
  const source = new SuggestionContext()
  source.user('Run authentication tests')
  let processes = [task()]
  let requests = 0
  const ticks = () => new Promise<void>(resolve => setImmediate(resolve))
  const controller = new PromptSuggestion({
    key: () => 'session', eligible: () => true, changed: () => {},
    context: () => source.snapshot({ ...IDLE_WORKFLOW, execution: processes.length ? 'waiting' : 'idle', background: processes.length,
      activities: activeWork(processes, null, false) }),
    start: (_messages, hints) => {
      requests++
      expect(hints?.workflow?.runtime.activities?.[0]?.goal).toBe(processes.length ? 'Run focused authentication tests' : undefined)
      return { result: async () => 'Check the test progress', abort: () => {} }
    },
  })
  controller.complete('')
  await ticks()
  controller.cancel()
  processes = [task({ elapsed_ms: 126_000, quiet_for_ms: 63_000 })]
  controller.complete('')
  expect(requests).toBe(1) // sub-minute clock movement must not churn the exact cache
  processes = []
  controller.reconcile()
  expect(controller.text()).toBe('Check the test progress') // the selected batch stays stable
  controller.cancel()
  controller.complete('')
  await ticks()
  expect(requests).toBe(2)
})
