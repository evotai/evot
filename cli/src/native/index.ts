/**
 * Typed wrapper around the NAPI native addon.
 * All Rust types cross the boundary as JSON strings — this module
 * parses them into proper TS interfaces.
 */

import { shareCreated, shareList, type ShareNotice } from './contracts/share.js'
import { cloudPushProgress, cloudPushResult, cloudPullResult, remoteSessions, type CloudPushProgress, type CloudPushResult, type CloudPullResult, type RemoteSession } from './contracts/cloud.js'
export type { CloudPushProgress, CloudPushResult, CloudPullResult, RemoteSession } from './contracts/cloud.js'
export type { CloudSync, CloudVisibility } from './contracts/results.js'
// @ts-ignore — binding.js is generated
import { NapiAgent as RawAgent, version as rawVersion, startServer as rawStartServer, startServerBackground as rawStartServerBackground, fastExit as rawFastExit, reapExitedChildren as rawReapExitedChildren, authBegin as rawAuthBegin, authPoll as rawAuthPoll, authLogout as rawAuthLogout, authSyncModels as rawAuthSyncModels, authSyncNotices as rawAuthSyncNotices, authWhoami as rawAuthWhoami, authRefreshSession as rawAuthRefreshSession, authNotices as rawAuthNotices, taskList as rawTaskList, taskDeliveryDefaults as rawTaskDeliveryDefaults, taskGet as rawTaskGet, taskCreate as rawTaskCreate, taskUpdate as rawTaskUpdate, taskDelete as rawTaskDelete, taskRun as rawTaskRun, taskShare as rawTaskShare, taskShareFetch as rawTaskShareFetch, taskShareId as rawTaskShareId } from './binding.js'

import { QueryStream } from './query-stream.js'
export { QueryStream } from './query-stream.js'
export type { QueuedPrompt, PromptQueueKind } from './query-stream.js'
export type { RunEvent, QueryEvent, HostToolEvent } from './contracts/query-event.js'
import { decodeConfigInfo, type ConfigInfo } from './contracts/config-info.js'
export type { ConfigInfo, ModelOption, ModelProtocol } from './contracts/config-info.js'

import type { NativeAgent, NativeCompaction, NativeForkedAgent } from './contracts/ports.js'

// ---------------------------------------------------------------------------
// Event types (mirrors Rust RunEvent / RunEventPayload)
// ---------------------------------------------------------------------------

import * as results from './contracts/results.js'
import { decodeResult } from './contracts/results.js'
import type { SessionMeta, SessionWithText, TranscriptItem, VariableInfo, BackgroundProcess, ManualCompactionOutcome, CompactionPhase } from './contracts/results.js'
export type { SessionMeta, SessionWithText, TranscriptItem, VariableInfo, BackgroundProcess, ManualCompactionOutcome, CompactionPhase } from './contracts/results.js'

/** Where `reloadSelectionOutcome` left the live model. */
export type SelectionReloadOutcome = 'kept' | 'followed' | 'switched' | 'unconfigured'

const SELECTION_RELOAD_OUTCOMES: ReadonlySet<string> = new Set(['kept', 'followed', 'switched', 'unconfigured'])

function isSelectionReloadOutcome(value: string): value is SelectionReloadOutcome {
  return SELECTION_RELOAD_OUTCOMES.has(value)
}

export type SubmitOutcome =
  | { kind: 'run'; stream: QueryStream }
  | { kind: 'command'; message: string }

// ---------------------------------------------------------------------------
// Content block types for multi-content queries
// ---------------------------------------------------------------------------

export interface TextContentBlock {
  type: 'text'
  text: string
}

export type ImageContentSource =
  | { type: 'path'; path: string }
  | { type: 'base64'; data: string; path?: string }

export interface ImageContentBlock {
  type: 'image'
  mimeType: string
  source: ImageContentSource
}

export type ContentBlock = TextContentBlock | ImageContentBlock

// ---------------------------------------------------------------------------
// Agent — main entry point
// ---------------------------------------------------------------------------

export class CompactionTask {
  constructor(private readonly raw: NativeCompaction) {}

  get phase(): CompactionPhase {
    return results.compactionPhase.read(this.raw.phase, '$.phase')
  }

  async result(): Promise<ManualCompactionOutcome> {
    return decodeResult(await this.raw.result(), results.compactionOutcome)
  }

  abort(): void {
    this.raw.abort()
  }
}

/**
 * Decode native progress ticks for a caller's listener. A malformed tick is
 * dropped: progress is advisory and the final result still arrives.
 */
function progressRelay(onProgress?: (progress: CloudPushProgress) => void): ((raw: string) => void) | undefined {
  if (!onProgress) return undefined
  return raw => {
    try { onProgress(decodeResult(raw, cloudPushProgress)) } catch { /* advisory */ }
  }
}

export class Agent {
  private constructor(private readonly raw: NativeAgent) {}

  static async create(model?: string, envFile?: string): Promise<Agent> {
    const raw = await RawAgent.create(model ?? null, envFile ?? null)
    return new Agent(raw)
  }

  get model(): string {
    return this.raw.model
  }

  set model(value: string) {
    this.raw.model = value
  }

  get cwd(): string {
    return this.raw.cwd
  }

  async query(prompt: string, sessionId?: string, toolMode?: string, contentJson?: string, hostSpecsJson?: string): Promise<QueryStream> {
    const outcome = await this.raw.query(prompt, sessionId ?? null, toolMode ?? null, contentJson ?? null, hostSpecsJson ?? null)
    if (outcome.kind !== 'run') {
      throw new Error(`Expected run, got command: ${outcome.message}`)
    }
    const run = outcome.takeRun()
    if (!run) {
      throw new Error('No run in submit outcome')
    }
    return new QueryStream(run)
  }

  /**
   * Unified submit — handles both commands and normal queries.
   * Commands return { kind: 'command', message }, queries return { kind: 'run', stream }.
   */
  async submit(
    prompt: string,
    sessionId?: string,
    toolMode?: string,
    contentJson?: string,
    hostSpecsJson?: string,
  ): Promise<SubmitOutcome> {
    const outcome = await this.raw.query(prompt, sessionId ?? null, toolMode ?? null, contentJson ?? null, hostSpecsJson ?? null)
    if (outcome.kind === 'command') {
      return { kind: 'command', message: outcome.message ?? '' }
    }
    const run = outcome.takeRun()
    if (!run) {
      throw new Error('No run in submit outcome')
    }
    return { kind: 'run', stream: new QueryStream(run) }
  }

  async createSession(): Promise<SessionMeta> {
    const json = await this.raw.createSession()
    return decodeResult(json, results.sessionMeta)
  }

  async listSessions(limit?: number): Promise<SessionMeta[]> {
    const json = await this.raw.listSessions(limit ?? null)
    return decodeResult(json, results.sessions)
  }

  async renameSession(sessionId: string, title: string): Promise<SessionMeta> {
    return decodeResult(await this.raw.renameSession(sessionId, title), results.sessionMeta)
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.raw.deleteSession(sessionId)
  }

  /** Fork a session into a new persistent one inheriting its context. */
  async forkSession(sourceId: string, title?: string): Promise<SessionMeta> {
    return decodeResult(await this.raw.forkSession(sourceId, title ?? null), results.sessionMeta)
  }

  /** Fork ancestry, root first and `sessionId` last. */
  async sessionLineage(sessionId: string): Promise<SessionMeta[]> {
    return decodeResult(await this.raw.sessionLineage(sessionId), results.sessions)
  }

  backgroundProcesses(sessionId: string): BackgroundProcess[] {
    return decodeResult(this.raw.backgroundProcesses(sessionId), results.backgroundProcesses)
  }

  async stopBackgroundProcess(sessionId: string, taskId: string): Promise<BackgroundProcess | null> {
    const json = await this.raw.stopBackgroundProcess(sessionId, taskId)
    return json ? decodeResult(json, results.backgroundProcess) : null
  }

  async stopAllBackgroundProcesses(sessionId: string): Promise<BackgroundProcess[]> {
    const json = await this.raw.stopAllBackgroundProcesses(sessionId)
    return decodeResult(json, results.backgroundProcesses)
  }

  /** Detach every foreground shell so the turn can be reclaimed without
   *  discarding work. The processes keep running; only the waiting ends.
   *  Returns how many moved. */
  backgroundForegroundProcesses(sessionId: string): number {
    return this.raw.backgroundForegroundProcesses(sessionId)
  }

  /** Same detach, attributed to a queued message needing delivery. Steering is
   *  only inspected between tool calls, so a foreground shell would otherwise
   *  hold a typed message until it finished. */
  backgroundForegroundProcessesForMessage(sessionId: string): number {
    return this.raw.backgroundForegroundProcessesForMessage(sessionId)
  }

  /** Blocking `task_output` waits in flight. Such a wait holds the turn while
   *  the task it watches is already backgrounded, so no foreground shell exists
   *  to detach. */
  blockingTaskWaits(sessionId: string): number {
    return this.raw.blockingTaskWaits(sessionId)
  }

  /** End in-flight blocking waits, returning how many were released. The
   *  watched tasks keep running; only the waiting ends. */
  releaseBlockingTaskWaits(sessionId: string): number {
    return this.raw.releaseBlockingTaskWaits(sessionId)
  }

  /** Completion notices queued but not yet delivered to a turn. Non-consuming:
   *  only a turn can carry them, so the UI polls this to decide whether to
   *  open one. */
  pendingProcessNotifications(sessionId: string): number {
    return this.raw.pendingProcessNotifications(sessionId)
  }

  pendingProcessWakeNotifications(sessionId: string): number {
    return this.raw.pendingProcessWakeNotifications(sessionId)
  }

  /** Kill every background process synchronously. Safe to call before fastExit,
   *  which skips the async teardown that would otherwise stop them. */
  killAllBackgroundProcessesNow(): number {
    return this.raw.killAllBackgroundProcessesNow()
  }

  async listSessionsWithText(limit?: number): Promise<SessionWithText[]> {
    const json = await this.raw.listSessionsWithText(limit ?? null)
    return decodeResult(json, results.sessionsWithText)
  }

  /** One session's text, or null when it is gone. */
  async sessionWithText(sessionId: string): Promise<SessionWithText | null> {
    const json = await this.raw.sessionWithText(sessionId)
    return json === null ? null : decodeResult(json, results.sessionWithText)
  }

  async shareSession(sessionId: string) {
    return decodeResult(await this.raw.shareSession(sessionId), shareCreated)
  }

  async listShares() {
    return decodeResult(await this.raw.listShares(), shareList).shares
  }

  async deleteShare(id: string): Promise<void> {
    await this.raw.deleteShare(id)
  }

  // Cloud session sync: the session itself, kept whole, on the owner's server.
  /**
   * `keep` leaves an already-shared session's access unchanged (new ones start
   * private). `onProgress` fires after each uploaded batch of a long push.
   */
  async cloudShareSession(
    sessionId: string,
    visibility: 'private' | 'team' | 'public' | 'keep',
    onProgress?: (progress: CloudPushProgress) => void,
  ): Promise<CloudPushResult> {
    const raw = await this.raw.cloudShareSession(sessionId, visibility, progressRelay(onProgress))
    return decodeResult(raw, cloudPushResult)
  }

  async cloudPushSession(
    sessionId: string,
    force = false,
    onProgress?: (progress: CloudPushProgress) => void,
  ): Promise<CloudPushResult> {
    const raw = await this.raw.cloudPushSession(sessionId, force, progressRelay(onProgress))
    return decodeResult(raw, cloudPushResult)
  }

  async cloudUnshareSession(sessionId: string): Promise<void> {
    await this.raw.cloudUnshareSession(sessionId)
  }

  /** Empty when signed out; never throws for a missing login. */
  async cloudListSessions(): Promise<RemoteSession[]> {
    return decodeResult(await this.raw.cloudListSessions(), remoteSessions)
  }

  async cloudPullSession(sessionId: string): Promise<CloudPullResult> {
    return decodeResult(await this.raw.cloudPullSession(sessionId), cloudPullResult)
  }

  async cloudForkRemoteSession(sessionId: string): Promise<SessionMeta> {
    return decodeResult(await this.raw.cloudForkRemoteSession(sessionId), results.sessionMeta)
  }

  /** `/share <url>`: fork a public page's transcript into a new local session. */
  async importSharedSession(link: string): Promise<SessionMeta> {
    return decodeResult(await this.raw.importSharedSession(link), results.sessionMeta)
  }

  async recordShareNotices(sessionId: string, notices: ShareNotice[]): Promise<void> {
    await this.raw.recordShareNotices(sessionId, JSON.stringify(notices))
  }

  async loadTranscript(sessionId: string): Promise<TranscriptItem[]> {
    const json = await this.raw.loadTranscript(sessionId)
    return decodeResult(json, results.transcript)
  }

  async loadContextTranscript(sessionId: string): Promise<TranscriptItem[]> {
    const json = await this.raw.loadContextTranscript(sessionId)
    return decodeResult(json, results.transcript)
  }

  async loadResumeTranscript(sessionId: string): Promise<TranscriptItem[]> {
    const json = await this.raw.loadResumeTranscript(sessionId)
    return decodeResult(json, results.transcript)
  }

  async findSession(sessionId: string): Promise<SessionMeta | null> {
    const json = await this.raw.findSession(sessionId)
    return json ? decodeResult(json, results.sessionMeta) : null
  }

  fork(systemPrompt: string): ForkedAgent {
    const raw = this.raw.fork(systemPrompt)
    return new ForkedAgent(raw)
  }

  listVariables(): VariableInfo[] {
    return decodeResult(this.raw.listVariables(), results.variables)
  }

  async setVariable(key: string, value: string): Promise<void> {
    await this.raw.setVariable(key, value)
  }

  async deleteVariable(key: string): Promise<boolean> {
    return this.raw.deleteVariable(key)
  }

  configInfo(): ConfigInfo {
    return decodeConfigInfo(this.raw.configInfo())
  }

  availableModels(): string[] {
    return this.raw.availableModels()
  }

  setProvider(provider: string): void {
    this.raw.setProvider(provider)
  }

  /**
   * Re-resolve the live model selection after login, logout, or key recovery.
   * A selection the fresh config still serves is kept, so recovering a scoped
   * key does not move this session onto a different model. Returns false only
   * when nothing is configured any more.
   */
  reloadSelection(): boolean {
    return this.raw.reloadSelection()
  }

  /**
   * Same reload, reporting where the selection landed: `kept`, `followed`
   * (the model id moved to another provider and was followed), `switched`
   * (a different model took over) or `unconfigured`.
   */
  reloadSelectionOutcome(): SelectionReloadOutcome {
    const raw = this.raw.reloadSelectionOutcome()
    return isSelectionReloadOutcome(raw) ? raw : 'switched'
  }

  /**
   * Reload provider/model from disk, including its configured thinking level.
   * Returns false when the saved selection is unavailable and the current live
   * selection was refreshed instead.
   */
  reloadProvider(provider: string): boolean {
    return this.raw.reloadProvider(provider)
  }

  /**
   * Advance the thinking level to the next tier the current model supports,
   * wrapping around. Returns the new level's display label, or null when the
   * model has no selectable reasoning levels.
   */
  cycleThinkingLevel(): string | null {
    return this.raw.cycleThinkingLevel()
  }

  /** Apply an explicit live thinking level when supported by the active model. */
  restoreThinkingLevel(level: string): void {
    this.raw.restoreThinkingLevel(level)
  }

  /**
   * Apply a named thinking level and persist it as the default. Returns the new
   * display label, or null when the active model does not offer that tier — the
   * live selection is then left untouched rather than clamped to a neighbour.
   */
  setThinkingLevel(level: string): string | null {
    return this.raw.setThinkingLevel(level)
  }

  /**
   * Make a cloud model the account's default for future sessions (on every
   * machine) without switching the live selection. Resolves to the pinned
   * model id, or null when the model is BYOK / not logged in — local config
   * already remembers those. Rejects when the server refuses the pin.
   */
  pinDefaultModel(provider: string, model: string): Promise<string | null> {
    return this.raw.pinDefaultModel(provider, model)
  }

  setLimits(maxTurns?: number, maxTokens?: number, maxDurationSecs?: number): void {
    this.raw.setLimits(maxTurns ?? null, maxTokens ?? null, maxDurationSecs ?? null)
  }

  appendSystemPrompt(extra: string): void {
    this.raw.appendSystemPrompt(extra)
  }

  addSkillsDirs(dirs: string[]): void {
    this.raw.addSkillsDirs(dirs)
  }

  setSkillNames(names: string[]): void {
    this.raw.setSkillNames(names)
  }

  /**
   * The fully-resolved, ordered skills directories the agent scans (managed
   * builtins + global + EVOT_SKILLS_DIRS from config/env-file + claude).
   * Read this instead of re-deriving from process.env so `/skill list` and the
   * banner match what the agent actually loads (see issue #38).
   */
  skillsDirs(): string[] {
    return this.raw.skillsDirs()
  }

  compact(sessionId: string, customInstructions?: string): CompactionTask {
    return new CompactionTask(this.raw.compact(sessionId, customInstructions || null))
  }

  steer(sessionId: string, text: string, contentJson?: string): void {
    this.raw.steer(sessionId, text, contentJson ?? null)
  }

  followUp(sessionId: string, text: string): void {
    this.raw.followUp(sessionId, text)
  }

  abortRun(sessionId: string): void {
    this.raw.abortRun(sessionId)
  }
}

// ---------------------------------------------------------------------------
// ForkedAgent — ephemeral readonly side conversation
// ---------------------------------------------------------------------------

export class ForkedAgent {
  constructor(private readonly raw: NativeForkedAgent) {}

  async query(prompt: string): Promise<QueryStream> {
    const raw = await this.raw.query(prompt)
    return new QueryStream(raw)
  }
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export function version(): string {
  return rawVersion()
}

export async function startServer(port?: number, model?: string, envFile?: string): Promise<void> {
  return rawStartServer(port ?? null, model ?? null, envFile ?? null)
}

import type { ServerInfo, LoginCodeResponse, AuthPollResult, CloudUser, AuthRefreshResult, CloudNotice } from './contracts/results.js'
export type { ServerInfo, LoginCodeResponse, AuthPollResult, CloudUser, AuthRefreshStatus, AuthRefreshResult, CloudNotice } from './contracts/results.js'

export async function startServerBackground(port?: number, model?: string, envFile?: string): Promise<ServerInfo | null> {
  const json = await rawStartServerBackground(port ?? null, model ?? null, envFile ?? null)
  if (json === null) return null
  return decodeResult(json, results.serverInfo)
}

/**
 * Terminate the process immediately via `std::process::exit`, bypassing all
 * Rust `Drop` impls and async runtime shutdown. Use on user-triggered exit so
 * large sessions don't stall on tokio runtime teardown.
 * Callers must restore terminal state (raw mode, cursor, bracketed paste)
 * before invoking this.
 */
export function fastExit(code = 0): never {
  rawFastExit(code)
  // rawFastExit does not return; this satisfies the `never` type
  throw new Error('unreachable')
}

/**
 * Reap every exited child of this process, waiting at most `timeoutMs` for
 * stragglers. Call right before `execve`: the new image keeps the pid but never
 * waits on children it did not spawn, so each one left behind becomes a zombie
 * until evot exits. Returns the number of children reaped.
 */
export function reapExitedChildren(timeoutMs: number): number {
  try {
    return rawReapExitedChildren(Math.max(0, Math.floor(timeoutMs)))
  } catch {
    // Reaping is best effort; an execve must never be blocked by it.
    return 0
  }
}

// ---------------------------------------------------------------------------
// Cloud auth (evot login)
// ---------------------------------------------------------------------------

function parseJsonOrThrow(raw: unknown, context: string): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    // The addon surfaces Rust errors as plain text — rethrow with context.
    throw new Error(`${context}: invalid native result at $`)
  }
}

export async function authBegin(serverUrl: string, fingerprintId: string): Promise<LoginCodeResponse> {
  return results.loginCode.read(parseJsonOrThrow(await rawAuthBegin(serverUrl, fingerprintId), 'login failed'), '$')
}

export async function authPoll(serverUrl: string, code: string, expiresAt: number): Promise<AuthPollResult> {
  return results.authPoll.read(parseJsonOrThrow(await rawAuthPoll(serverUrl, code, expiresAt), 'login polling failed'), '$')
}

export async function authSyncModels(): Promise<void> {
  await rawAuthSyncModels()
}

export async function authSyncNotices(): Promise<CloudNotice[]> {
  return results.cloudNotices.read(parseJsonOrThrow(await rawAuthSyncNotices(), 'notice sync failed'), '$')
}

export async function authLogout(): Promise<void> {
  await rawAuthLogout()
}

export async function authWhoami(): Promise<CloudUser | null> {
  const raw = await rawAuthWhoami()
  if (!raw) return null
  try {
    return decodeResult(raw, results.cloudUser)
  } catch {
    return null
  }
}

/** Re-mint the scoped LLM key after the gateway reported `session_revoked`. */
export async function authRefreshSession(): Promise<AuthRefreshResult> {
  return results.authRefresh.read(parseJsonOrThrow(await rawAuthRefreshSession(), 'session refresh failed'), '$')
}

export function authNotices(): CloudNotice[] {
  const raw = rawAuthNotices()
  if (!raw) return []
  try {
    return decodeResult(raw, results.cloudNotices)
  } catch {
    return []
  }
}

export const taskList = rawTaskList
export const taskDeliveryDefaults = rawTaskDeliveryDefaults
export const taskGet = rawTaskGet
export const taskCreate = rawTaskCreate
export const taskUpdate = rawTaskUpdate
export const taskDelete = rawTaskDelete
export const taskRun = rawTaskRun
export const taskShare = rawTaskShare
export const taskShareFetch = rawTaskShareFetch
export const taskShareId = rawTaskShareId
