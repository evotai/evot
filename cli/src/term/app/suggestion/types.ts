export type { SuggestionMessage, SuggestionCommand, SuggestionHints, SuggestionWorkflow } from '../../../native/contracts/suggestion.js'

/** `quiet`: an automatic request ran and the model found nothing to suggest.
 * Shown as a faint marker beside the placeholder, never as an error. */
export type SuggestionFeedback = 'pending' | 'none' | 'quiet' | 'failed' | 'unavailable' | 'timed_out' | 'unauthorized'
export interface SuggestionPosition { current: number; total: number }
