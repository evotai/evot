import type { NativeRun } from '../query-stream.js'

/** Addon method ports. JSON stays a string until a contract reader validates
 * it; importing these types never loads the platform binary. */
export interface NativeSubmitOutcome {
  readonly kind: string
  readonly message: string | null
  takeRun(): NativeRun | null
}
export interface NativeCompaction {
  readonly phase: unknown
  result(): Promise<string>
  abort(): void
}
export interface NativeForkedAgent { query(prompt: string): Promise<NativeRun> }
export interface NativeAgent {
  model: string
  readonly cwd: string
  query(prompt: string, sessionId: string | null, mode: string | null, content: string | null, hostSpecs: string | null): Promise<NativeSubmitOutcome>
  createSession(): Promise<string>
  listSessions(limit: number | null): Promise<string>
  renameSession(id: string, title: string): Promise<string>
  forkSession(sourceId: string, title: string | null): Promise<string>
  sessionLineage(id: string): Promise<string>
  deleteSession(id: string): Promise<boolean>
  backgroundProcesses(id: string): string
  stopBackgroundProcess(id: string, task: string): Promise<string | null>
  stopAllBackgroundProcesses(id: string): Promise<string>
  backgroundForegroundProcesses(id: string): number
  backgroundForegroundProcessesForMessage(id: string): number
  blockingTaskWaits(id: string): number
  releaseBlockingTaskWaits(id: string): number
  pendingProcessNotifications(id: string): number
  pendingProcessWakeNotifications(id: string): number
  killAllBackgroundProcessesNow(): number
  listSessionsWithText(limit: number | null): Promise<string>
  sessionWithText(id: string): Promise<string | null>
  shareSession(id: string): Promise<string>
  listShares(): Promise<string>
  cloudShareSession(id: string, visibility: string, onProgress?: (progress: string) => void): Promise<string>
  cloudPushSession(id: string, force: boolean, onProgress?: (progress: string) => void): Promise<string>
  cloudUnshareSession(id: string): Promise<void>
  cloudListSessions(): Promise<string>
  cloudPullSession(id: string): Promise<string>
  cloudForkRemoteSession(id: string): Promise<string>
  importSharedSession(link: string): Promise<string>
  deleteShare(id: string): Promise<void>
  recordShareNotices(id: string, json: string): Promise<void>
  loadTranscript(id: string): Promise<string>
  loadContextTranscript(id: string): Promise<string>
  loadResumeTranscript(id: string): Promise<string>
  findSession(id: string): Promise<string | null>
  fork(prompt: string): NativeForkedAgent
  listVariables(): string
  setVariable(key: string, value: string): Promise<void>
  deleteVariable(key: string): Promise<boolean>
  configInfo(): string
  availableModels(): string[]
  setProvider(provider: string): void
  reloadSelection(): boolean
  reloadSelectionOutcome(): string
  reloadProvider(provider: string): boolean
  cycleThinkingLevel(): string | null
  setThinkingLevel(level: string): string | null
  restoreThinkingLevel(level: string): void
  pinDefaultModel(provider: string, model: string): Promise<string | null>
  setLimits(turns: number | null, tokens: number | null, duration: number | null): void
  appendSystemPrompt(extra: string): void
  addSkillsDirs(dirs: string[]): void
  setSkillNames(names: string[]): void
  skillsDirs(): string[]
  compact(id: string, instructions: string | null): NativeCompaction
  steer(id: string, text: string, content: string | null): void
  followUp(id: string, text: string): void
  abortRun(id: string): void
}
