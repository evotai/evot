/**
 * AppState — top-level UI state and factory.
 */

import type { UIMessage, UIAssistantBlock, RunStats, VerboseEvent, AskUserRequest } from '../../../render/message-types.js'


// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

export interface AppState {
  /** Newest completed assistant messages only; see `MAX_RETAINED_MESSAGES`. */
  messages: UIMessage[]
  isLoading: boolean
  sessionId: string | null
  model: string
  cwd: string
  error: string | null
  /** Ordered blocks for the current partial assistant message. */
  currentAssistantContent: UIAssistantBlock[]
  /** Stats accumulated during the current run */
  currentRunStats: RunStats
  /** Start time of the current run */
  runStartTime: number
  /** Verbose inline events (LLM calls, compaction) shown during streaming */
  verboseEvents: VerboseEvent[]
  /** Timestamp of the last received token (for stall detection) */
  lastTokenAt: number
  /** Pending ask_user request from the agent (null = none) */
  askUserRequest: AskUserRequest | null
  /** Session-level cumulative token stats (not reset between runs) */
  sessionTokens: SessionTokenStats
  /** Fork ancestry titles, root → current. Empty for sessions that are not forks. */
  forkTrail: string[]
  /** `☁` while this session syncs to the cloud, `🌐` when it also has a public page. */
  cloudBadge: string
}

export interface SessionTokenStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  contextTokens: number
  contextWindow: number
}

export function emptyRunStats(): RunStats {
  return {
    durationMs: 0,
    turnCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    llmCalls: 0,
    contextTokens: 0,
    contextWindow: 0,
    toolBreakdown: [],
    llmCallDetails: [],
    compactHistory: [],
    lastMessageStats: null,
    lastLlmUsage: null,
    cumulativeStats: { userCount: 0, assistantCount: 0, toolResultCount: 0, imageCount: 0, userTokens: 0, assistantTokens: 0, toolResultTokens: 0, imageTokens: 0, toolDetails: [] },
    systemPromptTokens: 0,
  }
}

export function createInitialState(model: string, cwd: string): AppState {
  return {
    messages: [],
    isLoading: false,
    sessionId: null,
    model,
    cwd,
    error: null,
    currentAssistantContent: [],
    currentRunStats: emptyRunStats(),
    runStartTime: 0,
    verboseEvents: [],
    lastTokenAt: 0,
    askUserRequest: null,
    sessionTokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 0, contextWindow: 0 },
    forkTrail: [],
    cloudBadge: '',
  }
}
