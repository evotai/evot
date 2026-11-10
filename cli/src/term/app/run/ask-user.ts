import type { AskState } from '../../widgets/ask.js'
import type { AskUserAnswer } from '../../../render/message-types.js'

/** Split explicit newlines into physical rows with hanging indentation. */
export function prefixedAskLines(text: string, firstPrefix: string): string[] {
  const rows = text.split('\n')
  const continuationPrefix = ' '.repeat([...firstPrefix].length)
  return rows.map((row, index) => `${index === 0 ? firstPrefix : continuationPrefix}${row}`)
}

export function askStateToResponse(state: AskState): AskUserAnswer[] {
  return state.questions.map((question, index) => {
    const answer = state.answers[index]
    let text = 'Skipped'
    if (answer) {
      if (answer.customText !== null) {
        text = answer.customText
      } else if (answer.selectedOption !== null) {
        text = question.options[answer.selectedOption]?.label ?? 'Skipped'
      }
    }
    return {
      header: question.header,
      question: question.question,
      answer: text,
    }
  })
}
