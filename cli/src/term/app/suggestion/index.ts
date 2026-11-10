// Public facade; implementation is split by responsibility under suggestion/.
export { PromptSuggestion } from './controller.js'
export { SuggestionContext } from './context.js'
export type { SuggestionSnapshot, WorkflowRuntime } from './context.js'
export { createSuggestionInput } from './input.js'
export { SuggestionTicker } from './feedback.js'
export { TaskWaitSuggestion } from './task-wait.js'
export type { SuggestionCommand, SuggestionFeedback, SuggestionHints, SuggestionMessage } from './types.js'
