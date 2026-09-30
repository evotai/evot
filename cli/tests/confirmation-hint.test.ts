import { afterEach, expect, test } from 'bun:test'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import { confirmationHint, confirmationHintAnsi } from '../src/term/viewmodel/confirmation-hint.js'
import { getTheme, resetDetectedThemeScheme, setDetectedThemeScheme } from '../src/render/theme/index.js'
import { RunInteraction } from '../src/term/app/run-interaction.js'
import { runStatusPresentation } from '../src/term/viewmodel/run-status.js'
import { formatSpinnerLine, createSpinnerState } from '../src/term/spinner.js'
import { buildSelectorBlocks } from '../src/term/viewmodel/selector.js'
import { createResumeWindow } from '../src/term/app/selector-windows.js'
import { handleSelectorControl } from '../src/term/app/selector-control.js'
import { buildPromptFooterBlocks, type PromptFooterVM } from '../src/term/viewmodel/prompt-footer.js'

const colorLevel = chalk.level
afterEach(() => { chalk.level = colorLevel; resetDetectedThemeScheme() })
const ansiColor = (hex: string) => `\x1b[38;2;${hex.slice(1).match(/../g)!.map(v => parseInt(v, 16)).join(';')}m`

for (const scheme of ['dark', 'light'] as const) {
  test(`${scheme}: confirmation changes only the foreground, without bold or layout changes`, () => {
    setDetectedThemeScheme(scheme)
    const text = 'esc again to interrupt'
    expect(confirmationHint(text, false)).toEqual({ text, hex: getTheme().mutedHex })
    expect(confirmationHint(text, true)).toEqual({ text, hex: getTheme().accentHex })
    chalk.level = 3
    const normal = confirmationHintAnsi(text, false)
    const armed = confirmationHintAnsi(text, true)
    expect(armed).toContain(ansiColor(getTheme().accentHex))
    expect(armed).not.toContain('\x1b[1m')
    expect(armed).not.toContain('\x1b[2m')
    expect(stripAnsi(armed)).toBe(stripAnsi(normal))
    expect(confirmationHint('ctrl+b ctrl+b (twice)', false).hex).toBe(getTheme().mutedHex)
  })
}

test('spinner confirmation is amber only until the pending state expires or is consumed', () => {
  chalk.level = 3
  let now = 0
  const interaction = new RunInteraction(() => now)
  const input = { active: true, owner: {} }
  const spinner = createSpinnerState()
  const render = () => formatSpinnerLine(spinner, Date.now(), undefined, { interaction: interaction.snapshot(input) })
  const amber = ansiColor(getTheme().accentHex)
  expect(render()).not.toContain(amber)
  interaction.requestInterrupt(input)
  expect(runStatusPresentation(interaction.snapshot(input)).confirmationPending).toBe(true)
  expect(render()).toContain(amber)
  now = 5000
  expect(render()).not.toContain(amber)
  interaction.requestInterrupt(input)
  expect(render()).toContain(amber)
  interaction.requestInterrupt(input)
  expect(render()).not.toContain(amber)
})

test('delete confirmation colors the action and subtitle but not cancel; Esc clears it', () => {
  let state = createResumeWindow([{ id: 's1', label: 'One', preview: ['One'], hints: [{ keys: 'd', action: 'delete' }] }], undefined, true)
  const armed = handleSelectorControl(state, { type: 'char', char: 'd' })
  if (armed.kind !== 'update') throw new Error('expected confirmation')
  state = armed.state
  const spans = buildSelectorBlocks(state, 120).flatMap(b => b.lines).flatMap(l => l.spans)
  const action = spans.find(s => s.text === 'd confirm delete')
  expect(action).toEqual(confirmationHint('d confirm delete', true))
  const cancel = spans.find(s => s.text === 'esc')
  expect(cancel?.hex).not.toBe(getTheme().accentHex)
  const cleared = handleSelectorControl(state, { type: 'escape' })
  if (cleared.kind !== 'update') throw new Error('expected cancelled confirmation')
  const next = buildSelectorBlocks(cleared.state, 120).flatMap(b => b.lines).flatMap(l => l.spans)
  expect(next.some(s => s.text.includes('confirm delete'))).toBe(false)
})

test('background stop styling depends on state, not wording', () => {
  const input: PromptFooterVM = {
    columns: 160, model: '', provider: '', thinkingLevel: '', planning: false, logMode: false,
    dashboardUrl: null, cwd: '/work', gitBranch: null, contextTokens: 0, contextWindow: 0,
    backgroundProcessCount: 2, backgroundPanelDownAvailable: true,
    backgroundStopHint: 'stop these jobs', backgroundStopPending: true,
  }
  const spans = buildPromptFooterBlocks(input)[0]!.lines[0]!.spans
  expect(spans.find(s => s.text === 'stop these jobs')).toEqual(confirmationHint('stop these jobs', true))
  expect(spans.filter(s => s.hex === getTheme().accentHex)).toHaveLength(1)
  const normal = buildPromptFooterBlocks({ ...input, backgroundStopPending: false, backgroundStopHint: 'again is only text' })[0]!.lines[0]!.spans
  expect(normal.find(s => s.text === 'again is only text')?.hex).toBe(getTheme().mutedHex)
})
