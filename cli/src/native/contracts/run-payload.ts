import { array, boolean, json, nullable, number, object, oneOf, optional, tagged, text, toolDetail, uint, type Infer } from './schema.js'

const usage = object({ input: uint, output: uint, cache_read: optional(uint), cache_write: optional(uint) })
const metrics = object({ duration_ms: uint, ttfb_ms: uint, ttft_ms: uint, streaming_ms: uint, chunk_count: uint })
const messageStats = object({
  user_count: uint, assistant_count: uint, tool_result_count: uint,
  image_count: uint, image_path_count: uint, image_base64_count: uint,
  user_tokens: uint, assistant_tokens: uint, tool_result_tokens: uint, image_tokens: uint,
  tool_details: array(toolDetail),
})
const assistantBlock = tagged('type', {
  text: object({ type: oneOf('text'), text }),
  thinking: object({ type: oneOf('thinking'), text, metadata: optional(nullable(json)) }),
  tool_call: object({ type: oneOf('tool_call'), id: text, name: text, input: json, metadata: optional(nullable(json)) }),
})
const reason = oneOf('threshold', 'overflow', 'manual', 'prune', 'refusal')
const compactionResult = tagged('type', {
  no_op: object({ type: oneOf('no_op') }),
  compacted: object({
    type: oneOf('compacted'), before_message_count: uint, after_message_count: uint,
    before_tokens: uint, after_tokens: uint, messages_evicted: uint, current_run_reclaimed: uint,
    method: optional(nullable(oneOf('prune', 'remote', 'local', 'remote_failed_local'))),
    remote_blob_bytes: optional(nullable(uint)), fallback_reason: optional(nullable(text)),
  }),
})

/** Matches Rust RunEventPayload. Optional defaulted fields stay absent rather
 * than rewriting historical wire data. Tool-owned JSON is deliberately opaque. */
export const runPayloadSchemas = {
  run_started: object({}),
  turn_started: object({}),
  assistant_delta: object({ content_index: uint, content_type: oneOf('text', 'thinking'), delta: text }),
  assistant_tool_call: object({
    content_index: uint, tool_call_id: text, tool_name: text, phase: oneOf('start', 'delta', 'end'),
    delta: optional(nullable(text)), args: optional(nullable(json)),
  }),
  assistant_completed: object({
    content: array(assistantBlock), usage: optional(nullable(usage)), stop_reason: text,
    error_message: optional(nullable(text)),
  }),
  tool_started: object({ tool_call_id: text, tool_name: text, args: json, preview_command: optional(nullable(text)) }),
  tool_progress: object({ tool_call_id: text, tool_name: text, text, details: optional(json) }),
  tool_finished: object({
    tool_call_id: text, tool_name: text, content: text, is_error: boolean, details: optional(json),
    result_tokens: optional(uint), duration_ms: optional(uint),
  }),
  llm_call_started: object({
    turn: uint, attempt: uint, injected_count: uint, model: text, message_count: uint, message_bytes: uint,
    estimated_context_tokens: optional(uint), system_prompt_tokens: uint, tool_definition_tokens: optional(uint),
    tool_count: uint, message_stats: optional(nullable(messageStats)), budget_tokens: optional(uint), context_window: optional(uint),
  }),
  llm_call_retry: object({ turn: uint, attempt: uint, max_retries: uint, delay_ms: uint, error: text }),
  quota_waiting: object({ delay_ms: uint, error: optional(text) }),
  outage_waiting: object({ delay_ms: uint, error: text }),
  llm_call_completed: object({
    turn: uint, attempt: uint, usage, cache_read: optional(uint), cache_write: optional(uint),
    error: optional(nullable(text)), metrics: optional(nullable(metrics)), context_window: optional(uint),
    stop_reason: optional(text), response_model: optional(nullable(text)),
    tool_calls: optional(nullable(array(object({ id: text, name: text, arguments: json })))),
  }),
  context_compaction_started: object({
    reason, message_count: optional(uint), estimated_tokens: uint, budget_tokens: uint,
    reserve_tokens: optional(uint), trigger_threshold: optional(uint), system_prompt_tokens: optional(uint),
    tool_definition_tokens: optional(uint), context_window: uint, will_retry: optional(boolean), message_stats: optional(nullable(messageStats)),
  }),
  context_compaction_phase: object({
    phase: oneOf('pruning', 'planning', 'remote', 'local_fallback', 'local', 'complete'),
    activity: optional(nullable(oneOf('waiting', 'generating'))),
  }),
  context_compaction_completed: object({ reason, result: compactionResult, summary: optional(nullable(text)), context_window: optional(uint), will_retry: optional(boolean) }),
  // Retired events are decoded for historical payloads, never acted on.
  tool_calls_reviewed: object({
    calls: array(object({ tool_call_id: text, tool_name: text, arguments: text, relevance: number })),
  }),
  context_pruned: object({
    decided: optional(nullable(object({
      verdicts: array(object({
        call_id: text, tool_name: text, arguments: text,
        decision: oneOf('keep', 'truncate', 'remove'),
        keep_call: optional(nullable(number)), keep_result: optional(nullable(number)),
        saves_tokens: uint,
      })),
      context_tokens: uint, pending_tokens: uint, requests: uint, elapsed_ms: uint,
      // Evidence for the verdicts; studied offline, not rendered.
      user_requests: optional(array(object({
        message_index: uint, text, probability: optional(nullable(number)), in_play: boolean,
      }))),
      batches: optional(array(object({ from: uint, to: uint, state_tokens: uint, call_ids: array(text) }))),
    }))),
    applied: optional(nullable(object({
      removed: uint, truncated: uint, skipped: uint,
      before_tokens: uint, after_tokens: uint, before_messages: uint, after_messages: uint,
      // `savings` / `cold_cache` were emitted before the prune threshold
      // existed; events persisted then must still decode.
      trigger: oneOf('run_end', 'threshold', 'before_compaction', 'manual', 'savings', 'cold_cache'),
    }))),
    context_window: optional(uint),
  }),
  run_finished: object({
    text, usage, turn_count: uint, duration_ms: uint, transcript_count: uint,
    compact_history: optional(array(object({ level: uint, from_tokens: uint, to_tokens: uint, action_map: text }))),
  }),
  error: object({ message: text }),
} as const

export type RunPayloads = { [K in keyof typeof runPayloadSchemas]: Infer<(typeof runPayloadSchemas)[K]> }
export type KnownRunKind = keyof RunPayloads

export function isKnownRunKind(kind: string): kind is KnownRunKind {
  return Object.hasOwn(runPayloadSchemas, kind)
}

export function validateRunPayload(kind: string, payload: unknown): void {
  if (isKnownRunKind(kind)) runPayloadSchemas[kind].read(payload, '$.payload')
}
