/**
 * State types for the CLI UI layer.
 */

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'system'

export interface UIMessage {
  id: string
  role: MessageRole
  /** User text, or a legacy assistant fallback for old transcripts. */
  text: string
  timestamp: number
  /** Ordered assistant content, matching pi's AssistantMessage.content. */
  content?: UIAssistantBlock[]
  /** Persisted compaction boundary reconstructed for transcript display. */
  compaction?: UICompaction
  /** Verbose events that occurred before this message */
  verboseEvents?: VerboseEvent[]
}

export interface UICompaction {
  reason: 'threshold' | 'overflow' | 'manual' | 'prune' | 'refusal'
  summary: string
  tokensBefore: number
  tokensAfter: number
  messagesBefore: number
  messagesAfter: number
  method?: string
  remoteBlobBytes?: number
  fallbackReason?: string
}

export type UIAssistantBlock =
  | { type: 'text'; contentIndex: number; text: string }
  | { type: 'thinking'; contentIndex: number; text: string }
  | { type: 'tool_call'; contentIndex: number; toolCall: UIToolCall }

export interface UIToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  status: 'queued' | 'running' | 'done' | 'error'
  /** Raw JSON argument fragments for the in-progress call. */
  partialArgs?: string
  /** Tool arguments are complete and execution may begin. */
  argsComplete?: boolean
  /** Wall-clock timestamp when execution started. */
  startedAt?: number
  /** Latest partial output for this tool. */
  progress?: string
  /** Structured partial/final metadata, including edit diffs. */
  details?: unknown
  result?: string
  previewCommand?: string
  durationMs?: number
}

// ---------------------------------------------------------------------------
// Run stats — accumulated during a run, shown in verbose mode
// ---------------------------------------------------------------------------

export interface RunStats {
  durationMs: number
  turnCount: number
  toolCallCount: number
  toolErrorCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  llmCalls: number
  contextTokens: number
  contextWindow: number
  toolBreakdown: ToolBreakdownEntry[]
  llmCallDetails: LlmCallDetail[]
  compactHistory: CompactRecord[]
  /** Last LLM call snapshot (used for per-call verbose display) */
  lastMessageStats: MessageStats | null
  /**
   * Usage from the most recently completed LLM call in this run.
   * Spinner token/cache stats prefer this over run-cumulative totals so a long
   * agent loop does not collapse into a meaningless 90%+ session average.
   */
  lastLlmUsage: LlmCallUsage | null
  /** Cumulative token breakdown across all LLM calls (kept for compatibility) */
  cumulativeStats: MessageStats
  systemPromptTokens: number
}

export interface LlmCallUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface LlmCallDetail {
  model: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  ttfbMs: number
  ttftMs: number
  tokPerSec: number
}

export interface ToolBreakdownEntry {
  name: string
  count: number
  totalDurationMs: number
  errors: number
}

export interface CompactRecord {
  beforeTokens?: number
  afterTokens?: number
  from_tokens?: number
  to_tokens?: number
  fromTokens?: number
  toTokens?: number
}

// ---------------------------------------------------------------------------
// Message stats — token breakdown by role
// ---------------------------------------------------------------------------

export interface MessageStats {
  userCount: number
  assistantCount: number
  toolResultCount: number
  imageCount: number
  userTokens: number
  assistantTokens: number
  toolResultTokens: number
  imageTokens: number
  /** Per-tool token breakdown: [name, tokens], sorted by tokens desc */
  toolDetails: [string, number][]
}

// ---------------------------------------------------------------------------
// Verbose events
// ---------------------------------------------------------------------------

export interface VerboseEvent {
  kind: 'llm_call' | 'llm_retry' | 'llm_completed' | 'compact_call' | 'compact_done'
  text: string
  expandedText?: string
}

// ---------------------------------------------------------------------------
// AskUser types — structured questions from the agent
// ---------------------------------------------------------------------------

export interface AskUserOption {
  label: string
  description: string
}

export interface AskUserQuestion {
  header: string
  question: string
  options: AskUserOption[]
}

export interface AskUserRequest {
  questions: AskUserQuestion[]
}

export interface AskUserAnswer {
  header: string
  question: string
  answer: string
}
