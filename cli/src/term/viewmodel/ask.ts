import { wrapTextWithAnsi } from '../../render/wrap.js'
import { blocksToLines, styledLineToAnsi } from './types.js'
import { isFreeText, type AskState } from '../ask.js'
import { prefixedAskLines } from '../app/ask-user.js'
import { CURSOR_MARKER } from '../render-frame.js'
import { getTheme } from '../../render/theme/index.js'
import { rowMarker } from './selector-row.js'
import { line, block, plain, dim, bold, colored, inverse, ansi, type ViewBlock, type StyledSpan, type StyledLine } from './types.js'

/** A question line that arrives already painted (a diff, say) is shown as
 *  is; wrapping it in bold would nest reset codes. */
function questionLine(text: string): StyledSpan {
  return /\x1b\[/.test(text) ? ansi(text) : bold(text)
}

const CHECKBOX_ON = '☒'
const CHECKBOX_OFF = '☐'
const TICK = '✓'
const BULLET = '•'
const ARROW_RIGHT = '→'

function selectedAnswerText(state: AskState, questionIndex: number): string | null {
  const answer = state.answers[questionIndex]
  if (!answer) return null
  if (answer.customText !== null) return answer.customText
  if (answer.selectedOption !== null) return state.questions[questionIndex]?.options[answer.selectedOption]?.label ?? null
  return null
}

function isAnswered(state: AskState, index: number): boolean {
  const a = state.answers[index]
  return a !== undefined && (a.selectedOption !== null || a.customText !== null)
}

export function buildAskRegionLines(state: AskState, columns: number): string[] {
  const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80
  const border = styledLineToAnsi(line(dim('─'.repeat(width))))
  const body = blocksToLines(buildAskBlocks(state, width))
    .flatMap(rendered => wrapTextWithAnsi(rendered, width))
  return ['', border, ...body, border]
}

/** Ask-user presentation, independent of selectors, native calls and layout ownership. */
export function buildAskBlocks(state: AskState, _columns: number): ViewBlock[] {
  const result: StyledLine[] = []
  const isMulti = state.questions.length > 1
  if (isMulti) {
    const tabLine: StyledSpan[] = []
    const canGoLeft = state.currentTab > 0 || state.onSubmitTab
    tabLine.push(canGoLeft ? plain('← ') : dim('← '))
    for (let i = 0; i < state.questions.length; i++) {
      if (i > 0) tabLine.push(plain('  '))
      const qq = state.questions[i]!
      const active = !state.onSubmitTab && i === state.currentTab
      const checkbox = isAnswered(state, i) ? CHECKBOX_ON : CHECKBOX_OFF
      tabLine.push(active ? inverse(` ${checkbox} ${qq.header} `) : plain(` ${checkbox} ${qq.header} `))
    }
    tabLine.push(plain('  '))
    tabLine.push(state.onSubmitTab ? inverse(` ${TICK} Submit `) : plain(` ${TICK} Submit `))
    tabLine.push(!state.onSubmitTab ? plain(' →') : dim(' →'))
    result.push(line(...tabLine), line(plain('')))
  }

  if (state.onSubmitTab) {
    const allAnswered = state.questions.every((_, i) => isAnswered(state, i))
    result.push(line(bold('Review your answers')), line(plain('')))
    if (!allAnswered) result.push(line(colored('⚠ You have not answered all questions', 'yellow')), line(plain('')))
    for (let i = 0; i < state.questions.length; i++) {
      const qq = state.questions[i]!
      const answerText = selectedAnswerText(state, i)
      if (!answerText) continue
      for (const text of prefixedAskLines(qq.question, `  ${BULLET} `)) {
        result.push(line(plain(text)))
      }
      for (const text of prefixedAskLines(answerText, `    ${ARROW_RIGHT} `)) {
        result.push(line(colored(text, 'green')))
      }
    }
    result.push(line(plain('')), line(dim('Ready to submit your answers?')), line(plain('')))
    const submitFocused = state.submitFocus === 0
    const cancelFocused = state.submitFocus === 1
    result.push(line(
      submitFocused ? rowMarker(true) : plain('  '),
      submitFocused ? bold('Submit answers') : plain('Submit answers'),
    ))
    result.push(line(
      cancelFocused ? rowMarker(true) : plain('  '),
      cancelFocused ? bold('Cancel') : plain('Cancel'),
    ))
    result.push(line(plain('')), line(dim('↑↓ navigate · enter select · ← back · esc cancel')))
    return [block(result, 1)]
  }

  const q = state.questions[state.currentTab]!
  for (const text of q.question.split('\n')) result.push(line(questionLine(text)))
  result.push(line(plain('')))
  const freeText = isFreeText(q)
  const ui = state.uiStates.get(state.currentTab) ?? { focusIndex: 0, inOtherMode: freeText, otherText: '', otherCursor: 0 }
  const answer = state.answers[state.currentTab]
  const otherSelected = answer !== undefined && answer.customText !== null
  const selectedIndex = !otherSelected ? answer?.selectedOption : null
  const maxIndexWidth = (q.options.length + 1).toString().length
  const optionIndex = (index: number) => `${index}.`.padEnd(maxIndexWidth + 2)
  const appendTick = (spans: StyledSpan[]): StyledSpan[] => [...spans, colored(TICK, 'green')]

  for (let i = 0; i < q.options.length; i++) {
    const opt = q.options[i]!
    const focused = !ui.inOtherMode && i === state.focusIndex
    const selected = selectedIndex === i
    const spans: StyledSpan[] = [
      focused ? rowMarker(true) : plain('  '),
      dim(optionIndex(i + 1)),
      selected ? colored(opt.label, 'green') : focused ? { text: opt.label, hex: getTheme().brandHex } : plain(opt.label),
    ]
    if (opt.description) spans.push(dim(` — ${opt.description}`))
    result.push(line(...(selected ? appendTick(spans) : spans)))
  }

  const otherFocused = ui.inOtherMode
  const otherText = otherFocused ? ui.otherText : otherSelected ? selectedAnswerText(state, state.currentTab) ?? '' : ui.otherText
  const placeholder = freeText ? 'Type your answer.' : 'Type something.'
  const otherSpans: StyledSpan[] = [otherFocused ? rowMarker(true) : plain('  ')]
  if (!freeText) otherSpans.push(dim(optionIndex(q.options.length + 1)))
  if (otherFocused) {
    if (otherText) {
      const cursor = ui.otherCursor ?? otherText.length
      const before = otherText.slice(0, cursor)
      const after = otherText.slice(cursor)
      if (before) otherSpans.push(plain(before))
      otherSpans.push(plain(CURSOR_MARKER))
      if (after) otherSpans.push(plain(after))
    } else {
      otherSpans.push(plain(CURSOR_MARKER), dim(placeholder))
    }
  } else {
    otherSpans.push(otherSelected ? colored(otherText || placeholder, 'green') : dim(otherText || placeholder))
  }
  if (otherSelected) otherSpans.push(plain(' '))
  result.push(line(...(otherSelected ? appendTick(otherSpans) : otherSpans)), line(plain('')))
  const hint = freeText
    ? (isMulti ? 'enter submit · ←→ switch tab · esc cancel' : 'enter submit · esc cancel')
    : (isMulti ? '↑↓ navigate · ←→ switch tab · enter select · esc cancel' : '↑↓ navigate · enter select · esc cancel')
  result.push(line(dim(hint)))
  return [block(result, 1)]
}
