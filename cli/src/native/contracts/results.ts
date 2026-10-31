import { array, boolean, nullable, object, oneOf, optional, tagged, text, uint, type Schema } from './schema.js'

/** Published addon results. Optional legacy fields remain absent; opaque
 * transcript/queue content and unknown extension keys are never rewritten. */
export interface SessionMeta {
  session_id: string
  title?: string | null
  custom_title?: string | null
  schema_version?: number
  model: string
  provider?: string
  thinking_level?: string | null
  cwd: string
  source?: string
  turns: number
  /** Session this one was forked from; absent for roots and older addons. */
  parent_session_id?: string | null
  fork_seq?: number | null
  /** Cloud sync state; absent for local-only sessions and older addons. */
  cloud?: CloudSync | null
  created_at: string
  updated_at: string
}
export type CloudVisibility = 'private' | 'public'
export interface CloudSync {
  visibility: CloudVisibility
  synced_seq: number
  synced_at: string
  origin_host?: string
  public_url?: string | null
  /** Signed-in members of the owner's group can read it; absent from older addons. */
  team?: boolean
  team_url?: string | null
  team_name?: string | null
}
export interface SessionWithText extends SessionMeta {
  search_text: string
  user_prompts: string[]
  /** First real user turn; absent from older addons and empty sessions. */
  first_prompt?: string
  /** Paths edited or written, first-seen order; absent from older addons. */
  changed_paths?: string[]
}
export interface TranscriptItem { [key: string]: unknown }
export interface VariableInfo { key: string; value: string; updated_at?: string }
export interface QueuedPrompt { id: string; version: number; message: Record<string, unknown> }
export interface BackgroundProcess {
  task_id: string
  command: string
  description?: string | null
  /** Bounded trailing output lines (≤ 8); empty until the task prints. Older addons omit it. */
  recent_output?: string[]
  quiet_for_ms?: number
  cwd: string
  output_path: string
  status: 'running_foreground' | 'running' | 'completed' | 'failed' | 'killed'
  exit_code: number | null
  elapsed_ms: number
  output_file_truncated: boolean
  stopped_by_user: boolean
}
export type ManualCompactionOutcome =
  | {
      status: 'compacted'; summary: string; tokens_before: number; tokens_after: number
      messages_before: number; messages_after: number; context_window: number
      messages_evicted: number; current_run_reclaimed: number; compaction_level: number
      used_fallback: boolean; method?: 'remote' | 'local' | 'remote_failed_local'
      remote_blob_bytes?: number; fallback_reason?: string
    }
  | { status: 'nothing_to_compact' }
  | { status: 'cancelled' }
export type CompactionPhase = 'pruning' | 'planning' | 'remote' | 'local_fallback' | 'local' | 'complete'
export type CompactionActivity = 'waiting' | 'generating'
export interface ServerInfo { port: number; address: string; channels: string[]; channelCount: number }
export interface LoginCodeResponse { code: string; login_url: string; expires_at: number; expires_in_ms: number; interval_ms: number }
export interface CloudUser { id: string; name: string; email: string }
export type AuthPollResult =
  | { status: 'pending' | 'expired' }
  | { status: 'denied'; reason?: string | null; reason_code?: string | null }
  | { status: 'success'; state: { user: CloudUser }; sync_error?: string }
export type AuthRefreshStatus = 'recovered' | 'login_required' | 'unavailable'
export interface AuthRefreshResult { status: AuthRefreshStatus; user: CloudUser | null; error?: string | null; cleanup_error?: string | null }
export interface CloudNotice { id: string; kind: string; priority?: number; title: string; body_md?: string }

const record: Schema<Record<string, unknown>> = object({})
const integer: Schema<number> = { read(value, path) {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`Invalid native result at ${path}`)
  return value
} }
export const cloudSync: Schema<CloudSync> = object({
  visibility: oneOf('private', 'public'), synced_seq: uint, synced_at: text,
  origin_host: optional(text), public_url: optional(nullable(text)),
  team: optional(boolean), team_url: optional(nullable(text)), team_name: optional(nullable(text)),
})
const sessionFields = {
  session_id: text, title: optional(nullable(text)), custom_title: optional(nullable(text)), schema_version: optional(uint), model: text, provider: optional(text),
  thinking_level: optional(nullable(text)), cwd: text, source: optional(text), turns: uint,
  parent_session_id: optional(nullable(text)), fork_seq: optional(nullable(uint)),
  cloud: optional(nullable(cloudSync)),
  created_at: text, updated_at: text,
}
export const sessionMeta: Schema<SessionMeta> = object(sessionFields)
export const sessions = array(sessionMeta)
export const sessionWithText: Schema<SessionWithText> = object({
  ...sessionFields, search_text: text, user_prompts: array(text),
  first_prompt: optional(text), changed_paths: optional(array(text)),
})
export const sessionsWithText: Schema<SessionWithText[]> = array(sessionWithText)
export const transcript: Schema<TranscriptItem[]> = array(record)
export const variables: Schema<VariableInfo[]> = array(object({ key: text, value: text, updated_at: optional(text) }))
export const queuedPrompt: Schema<QueuedPrompt> = object({ id: text, version: uint, message: record })
export const queuedPrompts = array(queuedPrompt)
export const backgroundProcess: Schema<BackgroundProcess> = object({
  task_id: text, command: text, cwd: text, output_path: text,
  description: optional(nullable(text)), quiet_for_ms: optional(uint),
  status: oneOf('running_foreground', 'running', 'completed', 'failed', 'killed'),
  exit_code: nullable(integer), elapsed_ms: uint, output_file_truncated: boolean, stopped_by_user: boolean,
})
export const backgroundProcesses = array(backgroundProcess)
export const compactionPhase: Schema<CompactionPhase> = oneOf('pruning', 'planning', 'remote', 'local_fallback', 'local', 'complete')
export const compactionActivity: Schema<CompactionActivity> = oneOf('waiting', 'generating')
export const compactionOutcome: Schema<ManualCompactionOutcome> = tagged('status', {
  compacted: object({
    status: oneOf('compacted'), summary: text, tokens_before: uint, tokens_after: uint,
    messages_before: uint, messages_after: uint, context_window: uint, messages_evicted: uint,
    // `compaction_level` predates single-step compaction; always 3, never read.
    current_run_reclaimed: uint, compaction_level: uint, used_fallback: boolean,
    method: optional(oneOf('remote', 'local', 'remote_failed_local')), remote_blob_bytes: optional(uint), fallback_reason: optional(text),
  }),
  nothing_to_compact: object({ status: oneOf('nothing_to_compact') }),
  cancelled: object({ status: oneOf('cancelled') }),
})
export const serverInfo: Schema<ServerInfo> = object({ port: uint, address: text, channels: array(text), channelCount: uint })
export const loginCode: Schema<LoginCodeResponse> = object({ code: text, login_url: text, expires_at: integer, expires_in_ms: integer, interval_ms: integer })
export const cloudUser: Schema<CloudUser> = object({ id: text, name: text, email: text })
export const authPoll: Schema<AuthPollResult> = tagged('status', {
  pending: object({ status: oneOf('pending') }), expired: object({ status: oneOf('expired') }),
  denied: object({ status: oneOf('denied'), reason: optional(nullable(text)), reason_code: optional(nullable(text)) }),
  success: object({ status: oneOf('success'), state: object({ user: cloudUser }), sync_error: optional(text) }),
})
export const authRefresh: Schema<AuthRefreshResult> = object({
  status: oneOf('recovered', 'login_required', 'unavailable'), user: nullable(cloudUser),
  error: optional(nullable(text)), cleanup_error: optional(nullable(text)),
})
export const cloudNotices: Schema<CloudNotice[]> = array(object({ id: text, kind: text, priority: optional(integer), title: text, body_md: optional(text) }))

/** Do not include JSON parser messages: they can quote private payload bytes. */
export function decodeResult<T>(raw: string, schema: Schema<T>): T {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('Invalid native result at $') }
  return schema.read(value, '$')
}
