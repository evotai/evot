export type { SuggestionMessage, SuggestionCommand, SuggestionHints, SuggestionWorkflow } from '../../../native/contracts/suggestion.js'

export type SuggestionFeedback = 'pending' | 'none' | 'failed' | 'unavailable' | 'timed_out' | 'unauthorized'
export interface SuggestionPosition { current: number; total: number }
