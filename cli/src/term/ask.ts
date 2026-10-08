import { nextGraphemeBoundary, previousGraphemeBoundary } from './input/grapheme.js'

export interface AskOption {
  label: string
  description?: string
}

export interface AskQuestion {
  header: string
  question: string
  options: AskOption[]
}

export interface AskAnswer {
  questionIndex: number
  selectedOption: number | null
  customText: string | null
}

/** Per-question UI state (preserved when switching tabs) */
export interface QuestionUIState {
  focusIndex: number
  inOtherMode: boolean
  otherText: string
  otherCursor: number
}

export interface AskState {
  /** Host setup prompts are transient UI, not conversation turns. */
  transient?: boolean
  owner?: symbol
  questions: AskQuestion[]
  currentTab: number
  focusIndex: number
  answers: AskAnswer[]
  /** Per-tab UI state keyed by question index */
  uiStates: Map<number, QuestionUIState>
  /** True when viewing the submit review page (multi-question only) */
  onSubmitTab: boolean
  /** Focus index within submit/cancel options (0=submit, 1=cancel) */
  submitFocus: number
  submitted: boolean
}

/** A question with no options is a free-text prompt: the only row is the input. */
export function isFreeText(question: AskQuestion): boolean {
  return question.options.length === 0
}

function initialUIState(state: AskState, tab: number): QuestionUIState {
  const question = state.questions[tab]
  const freeText = question !== undefined && isFreeText(question)
  return {
    focusIndex: 0,
    inOtherMode: freeText,
    otherText: '',
    otherCursor: 0,
  }
}

function getUIState(state: AskState, tab: number): QuestionUIState {
  return state.uiStates.get(tab) ?? initialUIState(state, tab)
}

function setUIState(
  state: AskState,
  tab: number,
  patch: Partial<QuestionUIState>,
): AskState {
  const existing = getUIState(state, tab)
  const next: QuestionUIState = {
    focusIndex: patch.focusIndex ?? existing.focusIndex,
    inOtherMode: patch.inOtherMode ?? existing.inOtherMode,
    otherText: patch.otherText ?? existing.otherText,
    otherCursor: patch.otherCursor ?? existing.otherCursor,
  }
  const uiStates = new Map(state.uiStates)
  uiStates.set(tab, next)
  return {
    ...state,
    uiStates,
    focusIndex: next.focusIndex,
  }
}

export function createAskState(questions: AskQuestion[]): AskState {
  return {
    questions,
    currentTab: 0,
    focusIndex: 0,
    answers: questions.map((_, i) => ({
      questionIndex: i,
      selectedOption: null,
      customText: null,
    })),
    uiStates: new Map(),
    onSubmitTab: false,
    submitFocus: 0,
    submitted: false,
  }
}

/** Total options including "Other" */
function optionCount(state: AskState): number {
  return state.questions[state.currentTab]!.options.length + 1
}

/** Current tab's inOtherMode */
function inOther(state: AskState): boolean {
  return getUIState(state, state.currentTab).inOtherMode
}

/** Current tab's otherText */
function otherText(state: AskState): string {
  return getUIState(state, state.currentTab).otherText
}

/** Whether the current tab already has a submitted answer */
function hasAnswer(state: AskState): boolean {
  const answer = state.answers[state.currentTab]
  return answer !== undefined && (answer.selectedOption !== null || answer.customText !== null)
}

function focusOption(state: AskState, index: number): AskState {
  const tab = state.currentTab
  const max = optionCount(state) - 1
  const next = Math.max(0, Math.min(index, max))
  const enteringOther = next === max
  const ui = getUIState(state, tab)
  return setUIState(state, tab, {
    focusIndex: next,
    inOtherMode: enteringOther,
    otherCursor: enteringOther ? ui.otherText.length : ui.otherCursor,
  })
}

export function askUp(state: AskState): AskState {
  const tab = state.currentTab
  const ui = getUIState(state, tab)
  if (isFreeText(state.questions[tab]!)) return state
  if (ui.inOtherMode) {
    return setUIState(state, tab, {
      inOtherMode: false,
      focusIndex: optionCount(state) - 2,
    })
  }
  if (ui.focusIndex <= 0) return state
  return setUIState(state, tab, { focusIndex: ui.focusIndex - 1 })
}

export function askDown(state: AskState): AskState {
  const tab = state.currentTab
  const ui = getUIState(state, tab)
  if (isFreeText(state.questions[tab]!)) return state
  const max = optionCount(state) - 1
  if (ui.focusIndex >= max) {
    return setUIState(state, tab, { inOtherMode: true, focusIndex: max, otherCursor: ui.otherText.length })
  }
  const next = ui.focusIndex + 1
  return setUIState(state, tab, {
    focusIndex: next,
    inOtherMode: next === max,
    otherCursor: next === max ? ui.otherText.length : ui.otherCursor,
  })
}

export function askNextTab(state: AskState): AskState {
  // If on submit tab, can't go further
  if (state.onSubmitTab) return state

  if (state.currentTab >= state.questions.length - 1) {
    if (state.questions.length > 1) {
      return { ...state, onSubmitTab: true, submitFocus: 0 }
    }
    return state
  }

  const next = state.currentTab + 1
  const ui = getUIState(state, next)
  return {
    ...state,
    currentTab: next,
    focusIndex: ui.focusIndex,
  }
}

export function askPrevTab(state: AskState): AskState {
  if (state.onSubmitTab) {
    // From submit tab, go back to last question
    const last = state.questions.length - 1
    const ui = getUIState(state, last)
    return {
      ...state,
      currentTab: last,
      focusIndex: ui.focusIndex,
      onSubmitTab: false,
    }
  }

  if (state.currentTab <= 0) return state
  const prev = state.currentTab - 1
  const ui = getUIState(state, prev)
  return {
    ...state,
    currentTab: prev,
    focusIndex: ui.focusIndex,
  }
}

export function askTypeChar(state: AskState, char: string): AskState {
  if (!inOther(state)) return state
  const tab = state.currentTab
  const ui = getUIState(state, tab)
  const before = ui.otherText.slice(0, ui.otherCursor)
  const after = ui.otherText.slice(ui.otherCursor)
  return setUIState(state, tab, {
    otherText: before + char + after,
    otherCursor: ui.otherCursor + char.length,
  })
}

/**
 * Paste text into the Other field. Enters Other mode if not already,
 * strips ANSI codes, and collapses newlines to spaces since the field
 * is rendered on a single line.
 */
export function askPasteText(state: AskState, text: string): AskState {
  const cleaned = text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, ' ')
  if (!cleaned.trim()) return state
  const tab = state.currentTab
  const ui = getUIState(state, tab)
  const cursor = ui.inOtherMode ? ui.otherCursor : ui.otherText.length
  const before = ui.otherText.slice(0, cursor)
  const after = ui.otherText.slice(cursor)
  return setUIState(state, tab, {
    inOtherMode: true,
    focusIndex: optionCount(state) - 1,
    otherText: before + cleaned + after,
    otherCursor: cursor + cleaned.length,
  })
}

export function askBackspace(state: AskState): AskState {
  if (!inOther(state)) return state
  const tab = state.currentTab
  const ui = getUIState(state, tab)
  if (ui.otherCursor <= 0) return state
  const start = previousGraphemeBoundary(ui.otherText, ui.otherCursor)
  const before = ui.otherText.slice(0, start)
  const after = ui.otherText.slice(ui.otherCursor)
  return setUIState(state, tab, {
    otherText: before + after,
    otherCursor: start,
  })
}

export function askClearOther(state: AskState): AskState {
  return setUIState(state, state.currentTab, { otherText: '', otherCursor: 0 })
}

export function askCursorLeft(state: AskState): AskState {
  if (!inOther(state)) return state
  const tab = state.currentTab
  const ui = getUIState(state, tab)
  if (ui.otherCursor <= 0) return state
  return setUIState(state, tab, { otherCursor: previousGraphemeBoundary(ui.otherText, ui.otherCursor) })
}

export function askCursorRight(state: AskState): AskState {
  if (!inOther(state)) return state
  const tab = state.currentTab
  const ui = getUIState(state, tab)
  if (ui.otherCursor >= ui.otherText.length) return state
  return setUIState(state, tab, { otherCursor: nextGraphemeBoundary(ui.otherText, ui.otherCursor) })
}

export function askCursorHome(state: AskState): AskState {
  if (!inOther(state)) return state
  return setUIState(state, state.currentTab, { otherCursor: 0 })
}

export function askCursorEnd(state: AskState): AskState {
  if (!inOther(state)) return state
  const tab = state.currentTab
  const ui = getUIState(state, tab)
  return setUIState(state, tab, { otherCursor: ui.otherText.length })
}

export function askDelete(state: AskState): AskState {
  if (!inOther(state)) return state
  const tab = state.currentTab
  const ui = getUIState(state, tab)
  if (ui.otherCursor >= ui.otherText.length) return state
  const before = ui.otherText.slice(0, ui.otherCursor)
  const after = ui.otherText.slice(nextGraphemeBoundary(ui.otherText, ui.otherCursor))
  return setUIState(state, tab, { otherText: before + after })
}

export type AskKeyResult =
  | { action: 'update'; state: AskState }
  | { action: 'cancel' }
  | { action: 'submit'; state: AskState }

export function handleAskKeyEvent(
  state: AskState,
  eventType: string,
  char?: string,
): AskKeyResult {
  const key = (state.onSubmitTab || !inOther(state)) && eventType === 'char' && char === 'j'
    ? 'j'
    : (state.onSubmitTab || !inOther(state)) && eventType === 'char' && char === 'k'
      ? 'k'
      : eventType
  // On submit tab, special handling
  if (state.onSubmitTab) {
    switch (key) {
      case 'escape':
        return { action: 'cancel' }
      case 'up':
      case 'ctrl+p':
      case 'k':
        return {
          action: 'update',
          state: { ...state, submitFocus: 0 },
        }
      case 'down':
      case 'ctrl+n':
      case 'j':
        return {
          action: 'update',
          state: { ...state, submitFocus: 1 },
        }
      case 'right':
      case 'tab':
        return { action: 'update', state: askNextTab(state) }
      case 'left':
      case 'shift-tab':
        return { action: 'update', state: askPrevTab(state) }
      case 'enter': {
        if (state.submitFocus === 0) {
          // Submit
          return { action: 'submit', state: { ...state, submitted: true } }
        }
        // Cancel
        return { action: 'cancel' }
      }
      default:
        return { action: 'update', state }
    }
  }

  switch (key) {
    case 'escape':
      return { action: 'cancel' }
    case 'up':
    case 'ctrl+p':
    case 'k':
      return { action: 'update', state: askUp(state) }
    case 'down':
    case 'ctrl+n':
    case 'j':
      return { action: 'update', state: askDown(state) }
    case 'page-up':
      if (inOther(state)) return { action: 'update', state }
      return { action: 'update', state: focusOption(state, state.focusIndex - 5) }
    case 'page-down':
      if (inOther(state)) return { action: 'update', state }
      return { action: 'update', state: focusOption(state, state.focusIndex + 5) }
    case 'shift-tab':
      return { action: 'update', state: askPrevTab(state) }
    case 'tab':
      return { action: 'update', state: askNextTab(state) }
    case 'right':
      if (inOther(state) && !hasAnswer(state)) return { action: 'update', state: askCursorRight(state) }
      return { action: 'update', state: askNextTab(state) }
    case 'left':
      if (inOther(state) && !hasAnswer(state)) return { action: 'update', state: askCursorLeft(state) }
      return { action: 'update', state: askPrevTab(state) }
    case 'char':
      if (inOther(state) && char)
        return { action: 'update', state: askTypeChar(state, char) }
      if (!inOther(state) && char && /^[1-9]$/.test(char)) {
        const index = Number(char) - 1
        if (index >= 0 && index < optionCount(state)) {
          const focused = focusOption(state, index)
          if (index === optionCount(state) - 1) return { action: 'update', state: focused }
          const result = askSelect(focused)
          if (result.done) return { action: 'submit', state: result.state }
          return { action: 'update', state: result.state }
        }
      }
      return { action: 'update', state }
    case 'paste':
      if (char !== undefined)
        return { action: 'update', state: askPasteText(state, char) }
      return { action: 'update', state }
    case 'backspace':
      if (inOther(state))
        return { action: 'update', state: askBackspace(state) }
      return { action: 'update', state }
    case 'delete':
      if (inOther(state))
        return { action: 'update', state: askDelete(state) }
      return { action: 'update', state }
    case 'home':
      if (inOther(state))
        return { action: 'update', state: askCursorHome(state) }
      return { action: 'update', state }
    case 'end':
      if (inOther(state))
        return { action: 'update', state: askCursorEnd(state) }
      return { action: 'update', state }
    case 'enter': {
      const result = askSelect(state)
      if (result.done) return { action: 'submit', state: result.state }
      return { action: 'update', state: result.state }
    }
    default:
      return { action: 'update', state }
  }
}

export function askSelect(state: AskState): { state: AskState; done: boolean } {
  const tab = state.currentTab
  const ui = getUIState(state, tab)
  const answers = [...state.answers]

  if (ui.inOtherMode && ui.otherText.trim()) {
    answers[tab] = {
      questionIndex: tab,
      selectedOption: null,
      customText: ui.otherText.trim(),
    }
  } else if (!ui.inOtherMode) {
    answers[tab] = {
      questionIndex: tab,
      selectedOption: ui.focusIndex,
      customText: null,
    }
  } else {
    return { state, done: false } // empty other text, do nothing
  }

  // After selecting, preserve the UI state so returning to this tab
  // shows the previously selected option (like Claude Code does)
  const newState = { ...state, answers }

  // Single question: auto-submit
  if (state.questions.length === 1) {
    return { state: { ...newState, submitted: true }, done: true }
  }

  // Multi question: advance to next tab or enter submit review if last
  if (tab < state.questions.length - 1) {
    const next = tab + 1
    const nextUI = getUIState(newState, next)
    return {
      state: {
        ...newState,
        currentTab: next,
        focusIndex: nextUI.focusIndex,
      },
      done: false,
    }
  }

  // Last question answered: enter submit review page
  return {
    state: {
      ...newState,
      onSubmitTab: true,
      submitFocus: 0,
    },
    done: false,
  }
}
