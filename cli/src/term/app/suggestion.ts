// Public facade; implementation is split by responsibility under suggestion/.
export { PromptSuggestion } from './suggestion/controller.js'
export { SuggestionContext } from './suggestion/context.js'
export type { SuggestionSnapshot, WorkflowRuntime } from './suggestion/context.js'
export { createSuggestionInput } from './suggestion/input.js'
export { SuggestionTicker } from './suggestion/feedback.js'
export { TaskWaitSuggestion } from './suggestion/task-wait.js'
export type { SuggestionCommand, SuggestionFeedback, SuggestionHints, SuggestionMessage } from './suggestion/types.js'
