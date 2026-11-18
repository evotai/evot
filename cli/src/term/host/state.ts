import { createInitialState } from '../app/run/state.js'
import { createPendingQueueState } from '../app/queue/pending-queue.js'
import { createSpinnerState, setSpinnerPhase } from '../widgets/spinner.js'
import { createEditorState, createHistoryState } from '../input/editor.js'
import { createAdSlotState } from '../viewmodel/ad-slot.js'
import type { AskUserAnswer } from '../../features/host-tools.js'
import type { TaskModelSelection } from '../../features/task/model-picker.js'
import type { ConfigInfo, ForkedAgent, QueryStream, SessionMeta } from '../../native/index.js'
import type { UIAssistantBlock } from '../../render/message-types.js'
import type { AuthWatcher } from '../app/auth/auth-watch.js'
import type { SuggestionTrigger } from '../app/composer/composer-guidance.js'
import type { SkillEntry } from '../../commands/skill/scan.js'
import type { PendingQueueState, QueueTarget, StartupQueueTarget } from '../app/queue/pending-queue.js'
import type { ComposerSnapshot } from '../app/composer/snapshot.js'
import type { ManagedQueuedPrompt } from '../app/queue/queue-manage.js'
import type { AppState } from '../app/run/state.js'
import type { StreamMachineState } from '../app/run/stream.js'
import type { OverlayState } from '../app/selector/overlay-state.js'
import type { ServerState } from '../app/server.js'
import type { ShareSelector } from '../app/session/share-selector.js'
import type { TerminalInputBuffer } from '../input/buffer.js'
import type { EditorState, HistoryState } from '../input/editor.js'
import type { AdSlotState } from '../viewmodel/ad-slot.js'
import type { ViewBlock } from '../viewmodel/index.js'
import type { SpinnerState } from '../widgets/spinner.js'
import type { EnhancedKeyboardSession } from '../../ui/keys.js'
import type { PreviewViewport } from '../../ui/preview-scroll.js'
import type { SelectorState } from '../../ui/selector.js'

export type CommandWindowPreview =
  | { kind: 'selector'; trigger: 'model' | 'resume' | 'skill' | 'task' | 'compute' | 'share'; sourceText: string; generation: number; state: SelectorState }
  | { kind: 'help'; trigger: 'help'; sourceText: string; generation: number }

/**
 * Mutable state of the interactive REPL host.
 *
 * One object shared by `startRepl` and the host controllers, so every writer
 * is visible as `st.<field> =`. The state is complete before controllers attach.
 */
export interface ReplState {
  historyRowCount: number
  appState: AppState
  spinnerState: SpinnerState
  /**
   * Spinner state for the idle wait on a detached task.
   *
   * Separate from `spinnerState` so the two never overwrite each other: a run
   * starting mid-wait resets its own animation, and the wait keeps its own
   * elapsed clock rather than inheriting the last run's.
   */
  backgroundWaitSpinner: SpinnerState
  backgroundWaitSince: number | null
  manualCompactionPhase: string | null
  manualCompactionActivity: string | null
  editor: EditorState
  historyState: HistoryState
  isLoading: boolean
  loginInFlight: boolean
  // Local foreground commands reuse the animated status row without pretending
  // they are abortable agent streams or showing stale LLM usage.
  foregroundCommand: 'log-shot' | null
  streamRef: QueryStream | null
  runStartedAt: number | null
  runTurnCount: number
  queueStartupTarget: StartupQueueTarget
  pendingQueue: PendingQueueState
  queueEditState: { entry: ManagedQueuedPrompt; stash: ComposerSnapshot; consumed: boolean } | null
  draftEpoch: number
  draftImageEpoch: number
  pendingEnqueue: { epoch: number; target: QueueTarget; chain: number; sequence: number } | null
  queueDispatchId: string | null
  spinnerTimer: ReturnType<typeof setInterval> | null
  shareSelector: ShareSelector | null
  // Sessions on the cloud follow the user across machines: pushed after each
  // run, listed beside local rows, pulled before resume. Never blocks input.
  refreshOpenSessionList: (() => void) | undefined
  destroyed: boolean
  composerRevision: number
  suggestionContextId: number
  suggestionsReady: boolean
  startupSuggestion: SuggestionTrigger | null
  terminalSuspended: boolean
  disableRaw: (() => void) | null
  enhancedKeyboard: EnhancedKeyboardSession | null
  inputBuffer: TerminalInputBuffer | null
  escapeFlushTimer: ReturnType<typeof setTimeout> | undefined
  onInputData: ((data: Buffer | string) => void) | null
  sessionId: string | null
  /** Fork ancestry of the current session, root → current; for exit hints. */
  lastLineage: SessionMeta[]
  nextBackgroundLineId: number
  logMode: ForkedAgent | null
  logDiscardTarget: ForkedAgent | null
  exitHint: boolean
  exitHintTimer: ReturnType<typeof setTimeout> | null
  overlay: OverlayState
  commandWindowPreview: CommandWindowPreview | null
  commandWindowPreviewGeneration: number
  focusedCommandWindowGeneration: number | null
  commandWindowContentLines: string[] | null
  commandWindowContentWidth: number | null
  selectorPreviewViewport: PreviewViewport | undefined
  deferredCloudModelNotice: string | null
  deferredCloudCampaignId: string | null
  deferredSkillNotice: string | null
  enrichedResumeMetadataGeneration: number | null
  enrichedResumeTextGeneration: number | null
  resumeCommandLoadTimer: ReturnType<typeof setTimeout> | undefined
  resumeSearchEnrichmentTimer: ReturnType<typeof setTimeout> | undefined
  /** Cancels the in-progress search-text warm-up, if one is running. */
  cancelSearchTextWarmup: (() => void) | null
  preloadedSessions: SessionMeta[]
  /** Invalidates callbacks belonging to an explicitly submitted `/resume`. */
  explicitResumeSelectorGeneration: number
  // Assigned after configInfo below, which decides the premium intake filter.
  adSlot: AdSlotState
  // Promise-based bridge for ask-user overlays (host tools and task actions).
  // Resolves with the collected answers, or null when the user cancels/skips.
  pendingAsk: ((answers: AskUserAnswer[] | null) => void) | null
  pendingTaskModel: ((selection: TaskModelSelection | null) => void) | null
  streamMachine: StreamMachineState | null
  /** Installed skill inventory shared by completion, dispatch and the skill window. */
  skillEntries: SkillEntry[]
  expanded: boolean
  /**
   * Height of the committed prefix's two parts as last painted. The renderer
   * treats that prefix as append-only by index, so a reshape must be announced.
   * Tracked separately because only history may grow: a banner gaining a row
   * pushes history down, which is a shift, not an append.
   */
  committedBannerRows: number | null
  committedHistoryRows: number
  committedPrefixMayReshape: boolean
  /** Unmount callback of the `/task` preview, while one is showing. */
  unmountTaskPreview: (() => void) | null
  unmountComputePreview: (() => void) | null
  liveContentMaxHeight: number
  liveContentWidth: number
  /**
   * First row of the redrawable region: everything above it is committed
   * transcript. Recorded by `buildFrame` so a keypress can release a native
   * terminal selection across the whole composer, not just the caret row.
   */
  liveRegionStartRow: number
  // Dashboard state
  serverState: ServerState | null
  // Update info
  updateAvailable: { version: string } | null
  updateStatus: 'idle' | 'downloading' | 'staged'
  updateVersion: string | null
  // Install bookkeeping. bin/evot reports its own version but the napi bindings
  // report nothing, so a half-finished install is otherwise silent until a
  // binding fails to load. Checked once at startup; never blocks.
  installDrift: string | null
  configInfo: ConfigInfo | undefined
  cloudLoginRequired: boolean
  revocationCleanup: Promise<void> | null
  authWatcher: AuthWatcher | null
  // Release notes (shown once after update)
  releaseNotes: string[] | null
  partialBlocksMemo: {
    content: UIAssistantBlock[]
    expanded: boolean
    streaming: boolean
    columns: number
    prevKind: string | undefined
    blocks: ViewBlock[]
  } | null
  titleFrame: number
  // Live sync: re-fetch the cloud catalog so new notices, ads and models
  // appear in-session without a restart. Silent when nothing changed.
  inflightSync: Promise<void> | null
}

export function createReplState(model: string, cwd: string): ReplState {
  return {
    historyRowCount: 0,
    appState: createInitialState(model, cwd),
    spinnerState: createSpinnerState(),
    backgroundWaitSpinner: setSpinnerPhase(createSpinnerState(), 'awaiting_background'),
    backgroundWaitSince: null,
    manualCompactionPhase: null,
    manualCompactionActivity: null,
    editor: createEditorState(),
    historyState: createHistoryState([]),
    isLoading: false,
    loginInFlight: false,
    foregroundCommand: null,
    streamRef: null,
    runStartedAt: null,
    runTurnCount: 0,
    queueStartupTarget: { startup: 0 },
    pendingQueue: createPendingQueueState(),
    queueEditState: null,
    draftEpoch: 0,
    draftImageEpoch: 0,
    pendingEnqueue: null,
    queueDispatchId: null,
    spinnerTimer: null,
    shareSelector: null,
    refreshOpenSessionList: undefined,
    destroyed: false,
    composerRevision: 0,
    suggestionContextId: 0,
    suggestionsReady: false,
    startupSuggestion: null,
    terminalSuspended: false,
    disableRaw: null,
    enhancedKeyboard: null,
    inputBuffer: null,
    escapeFlushTimer: undefined,
    onInputData: null,
    sessionId: null,
    lastLineage: [],
    nextBackgroundLineId: 1,
    logMode: null,
    logDiscardTarget: null,
    exitHint: false,
    exitHintTimer: null,
    overlay: { kind: 'none' },
    commandWindowPreview: null,
    commandWindowPreviewGeneration: 0,
    focusedCommandWindowGeneration: null,
    commandWindowContentLines: null,
    commandWindowContentWidth: null,
    selectorPreviewViewport: undefined,
    deferredCloudModelNotice: null,
    deferredCloudCampaignId: null,
    deferredSkillNotice: null,
    enrichedResumeMetadataGeneration: null,
    enrichedResumeTextGeneration: null,
    resumeCommandLoadTimer: undefined,
    resumeSearchEnrichmentTimer: undefined,
    cancelSearchTextWarmup: null,
    preloadedSessions: [],
    explicitResumeSelectorGeneration: 0,
    adSlot: createAdSlotState([]),
    pendingAsk: null,
    pendingTaskModel: null,
    streamMachine: null,
    skillEntries: [],
    expanded: false,
    committedBannerRows: null,
    committedHistoryRows: 0,
    committedPrefixMayReshape: false,
    unmountTaskPreview: null,
    unmountComputePreview: null,
    liveContentMaxHeight: 0,
    liveContentWidth: 0,
    liveRegionStartRow: 0,
    serverState: null,
    updateAvailable: null,
    updateStatus: 'idle',
    updateVersion: null,
    installDrift: null,
    configInfo: undefined,
    cloudLoginRequired: false,
    revocationCleanup: null,
    authWatcher: null,
    releaseNotes: null,
    partialBlocksMemo: null,
    titleFrame: 0,
    inflightSync: null,
  }
}
