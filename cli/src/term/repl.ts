import { TermRenderer } from './screen/renderer.js'
import { RenderDiagnostics } from './screen/render-diagnostics.js'
import { watchOutputFile } from './app/run/output-watch.js'
import { readOutputTail } from './app/run/output-tail.js'
import { TerminalInputBuffer } from './input/buffer.js'
import { createSpinnerState, setSpinnerPhase } from './widgets/spinner.js'
import { forkNotice } from './app/session/fork-nav.js'
import { isBackgroundSelector, SELECTOR_OWNER } from '../ui/selector-identity.js'
import { type AskQuestion } from './widgets/ask.js'
import { buildPrivacyCard, type OutputLine } from '../render/output.js'
import { createHyperlink } from '../ui/hyperlink.js'
import { renderErrorNotice } from '../ui/command-notice.js'
import { Agent, fastExit, authNotices, privacyLive, type SessionMeta } from '../native/index.js'
import { createInitialState } from './app/run/state.js'
import { assistantToolCalls } from './app/run/assistant-content.js'
import { HistoryManager } from '../session/history.js'
import { ScreenLog } from './diagnostics/screen-log.js'
import { SessionHook } from '../session/hook.js'
import { getSkillEntries } from '../commands/skill/scan.js'
import { promptInput } from '../commands/skill/invocation.js'
import { RendererTrace } from './diagnostics/renderer-trace.js'
import { BannerCache } from './widgets/banner-cache.js'
import { createAdSlotState, triggerAdSlot } from './viewmodel/ad-slot.js'
import { HistoryRenderCache } from './viewmodel/history-cache.js'
import { Committer } from './screen/committer.js'
import {
  createEditorState,
  getEditorText,
  editorCursorOffset,
  replaceAfterCursor,
  insertText,
  showCompletions,
  createHistoryState,
  type EditorState,
} from './input/editor.js'
import { UndoStack } from './input/undo-stack.js'
import { commandIdentity, validCommandInput } from './app/composer/command-arguments.js'
import { SuggestionContext } from './app/suggestion/context.js'
import { suggestionImages } from './app/suggestion/images.js'
import { prepareSuggestion } from './app/suggestion/request.js'
import { RunOwnership } from './app/run/run-ownership.js'
import { PromptSuggestion, SuggestionTicker, TaskWaitSuggestion, createSuggestionInput } from './app/suggestion/index.js'
import { allowedSuggestionCommand } from './app/composer/composer-guidance.js'
import { PrivacyFeed } from './app/privacy-feed.js'
import { currentModelSpec, formatModelOptionLabel, hasPremiumModel, isCloudModel } from '../features/models/options.js'
import chalk from 'chalk'
import {
  parsePasteRefs,
} from './input/paste_refs.js'
import { InputImageHistory } from './input/image-history.js'
import { tryStartServer, registerDashboard, stopOwnedServer, ownedDashboardPort } from './app/server.js'
import { BackgroundScheduler } from './app/background/scheduler.js'
import { inspectConsole } from '../features/channels/console-client.js'
import { findPreviousSession, shouldPreloadStartupSessions } from '../session/session-view.js'
import { ShareNotices } from '../session/share-notices.js'
import { CloudSessionSync, cloudLabel } from '../session/cloud-sessions.js'
import { AuthWatcher } from './app/auth/auth-watch.js'
import { AuthIdentityTracker } from './app/auth/auth-identity.js'
import { RunInteraction } from './app/run/run-interaction.js'
import { ManualCompaction } from './app/run/manual-compaction.js'
import { PendingImages } from './app/composer/pending-images.js'
import { createPasteHandlers, createPasteStore } from './app/composer/paste-input.js'
import { createQueueEdit } from './app/queue/queue-edit.js'
import { createQueueLifecycle } from './app/queue/queue-lifecycle.js'
import { PendingQueue, createPendingQueueState, currentQueueTarget } from './app/queue/pending-queue.js'
import { BackgroundTerminals } from './app/background/background-terminals.js'
import { awaitedTaskIds } from './app/background/background-panel.js'
import { FileCompletion } from './app/composer/file-completion-controller.js'
import { completeAtFile } from '../commands/file-completion.js'
import { OFFICIAL_SYNC_INTERVAL_MS, startOfficialSkillMaintenance } from '../commands/skill/index.js'
import { GitInfoProvider } from './git-info.js'
import { ResumeSessionCache } from './app/session/resume-cache.js'
import { ResumeItemCache } from './app/session/resume-items.js'
import { CloudSync, ModelAnnouncer } from './app/session/cloud-sync.js'
import { campaignContent } from './app/campaigns.js'
import { ResourceScope } from './screen/resource-scope.js'
import { RenderWakeup } from './screen/render-wakeup.js'
import { errorText } from '../ui/format.js'
import { RunThinking } from '../render/run-thinking.js'
import { TaskSession } from '../features/task/session.js'
import { ComputeSession } from '../features/compute/session.js'
import { LoopSession } from '../features/loop/session.js'
import { ensureFeishuDelivery } from '../features/channels/feishu/setup.js'
import { waitForSetup } from '../features/channels/setup-wait.js'
import { TerminalTitle } from './screen/title.js'
import {
  type ReplCommandContext,
} from './command-handlers.js'

import type { ReplState } from './host/state.js'
import { createCommandWindowController, type CommandWindowDeps } from './host/command-window.js'
import { createScrollbackController, type ScrollbackDeps } from './host/scrollback.js'
import { createAskController, type AskDeps } from './host/ask.js'
import { createFrameController, type FrameDeps } from './host/frame.js'
import { createCloudController, type CloudDeps } from './host/cloud.js'
import { createSessionController, type SessionDeps } from './host/session.js'
import { createIdleController, type IdleDeps } from './host/idle.js'
import { createSuggestController, type SuggestDeps } from './host/suggest.js'
import { createRunController, type RunDeps } from './host/run.js'
import { createCompactionController, type CompactionDeps } from './host/compaction.js'
import { createSlashController, type SlashDeps } from './host/slash.js'
import { createSubmitController, type SubmitDeps } from './host/submit.js'
import { createComposerController, type ComposerDeps } from './host/composer.js'
import { createSelectorKeysController, type SelectorKeysDeps } from './host/selector-keys.js'
import { createKeysController, type KeysDeps } from './host/keys.js'
import { createTerminalController, type TerminalDeps } from './host/terminal.js'

/** Everything the host controllers may ask of `startRepl`. */
type ReplHost =
  & CommandWindowDeps
  & ScrollbackDeps
  & AskDeps
  & FrameDeps
  & CloudDeps
  & SessionDeps
  & IdleDeps
  & SuggestDeps
  & RunDeps
  & CompactionDeps
  & SlashDeps
  & SubmitDeps
  & ComposerDeps
  & SelectorKeysDeps
  & KeysDeps
  & TerminalDeps

export interface ReplOptions {
  agent: Agent
  resumeSessionId?: string
  continueLatest?: boolean
  /** Start in a fresh fork of the given session, or of the latest in cwd. */
  forkFrom?: { sessionId?: string }
  serverPort?: number
  envFile?: string
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  const st = {} as ReplState
  // Ports the host controllers call back through. Getters resolve on every
  // use, so a controller sees a later-declared service exactly as a closure would.
  const host: ReplHost = {
    get agent() { return agent },
    get clearAll() { return composer.clearAll },
    get cloudSessions() { return cloudSessions },
    get computeSession() { return computeSession },
    get flushDeferredCloudUpdates() { return cloudCtl.flushDeferredCloudUpdates },
    get queueEdit() { return queueEdit },
    get queueLifecycle() { return queueLifecycle },
    get pendingQueue() { return pendingQueue },
    get renderer() { return renderer },
    get resumeCache() { return resumeCache },
    get resumeItems() { return resumeItems },
    get sessionCloudLabel() { return sessionCloudLabel },
    get taskSession() { return taskSession },
      get committer() { return committer },
    get compactLines() { return compactLines },
    get expandedLines() { return expandedLines },
    get liveWorkflowRuntime() { return suggest.liveWorkflowRuntime },
    get privacyFeed() { return privacyFeed },
    get runThinking() { return runThinking },
    get screenLog() { return screenLog },
    get suggestionContext() { return suggestionContext },
      get freezeTerminalTitle() { return freezeTerminalTitle },
    get refreshConfigInfo() { return refreshConfigInfo },
    get scrollback() { return scrollback },
    get sessionHook() { return sessionHook },
    get syncCloudNow() { return cloudCtl.syncCloudNow },
    get unfreezeTerminalTitle() { return idle.unfreezeTerminalTitle },
      get adSlotWakeup() { return adSlotWakeup },
    get appVersion() { return appVersion },
    get awaitedTaskSummary() { return idle.awaitedTaskSummary },
    get backgroundTerminals() { return backgroundTerminals },
    get bannerCache() { return bannerCache },
    get commandWindow() { return commandWindow },
    get compactHistoryCache() { return compactHistoryCache },
    get expandedHistoryCache() { return expandedHistoryCache },
    get gitInfo() { return gitInfo },
    get loopSession() { return loopSession },
    get manualCompaction() { return manualCompaction },
    get runInteraction() { return runInteraction },
    get runInteractionInput() { return runCtl.runInteractionInput },
    get suggestionTicker() { return suggestionTicker },
    get suggestions() { return suggestions },
      get cloudModels() { return cloudModels },
    get cloudSync() { return cloudSync },
    get frames() { return frames },
    get modelAnnouncer() { return modelAnnouncer },
    get refreshOpenModelSelector() { return sessionCtl.refreshOpenModelSelector },
    get taskIdentity() { return taskIdentity },
      get rendererTrace() { return rendererTrace },
    get requestProductSuggestion() { return suggest.requestProductSuggestion },
    get runQuery() { return runCtl.runQuery },
      get setTerminalTitle() { return setTerminalTitle },
    get suggestionTaskWait() { return suggestionTaskWait },
    get terminalTitle() { return terminalTitle },
      get pendingImages() { return pendingImages },
      get asks() { return asks },
    get cloudCtl() { return cloudCtl },
    get idle() { return idle },
    get runOwnership() { return runOwnership },
    get sessionCtl() { return sessionCtl },
    get shareNotices() { return shareNotices },
    get suggest() { return suggest },
      get runCtl() { return runCtl },
      get compaction() { return compaction },
    get exitAfterCleanup() { return exitAfterCleanup },
    get renderDiagnostics() { return renderDiagnostics },
    get replCommands() { return replCommands },
    get restartAfterCleanup() { return restartAfterCleanup },
      get buildImageContentBlocks() { return buildImageContentBlocks },
    get getDisplayText() { return composer.getDisplayText },
    get getExpandedText() { return composer.getExpandedText },
    get getHistoryText() { return composer.getHistoryText },
    get saveInputHistory() { return composer.saveInputHistory },
    get slashCtl() { return slashCtl },
      get editorUndo() { return editorUndo },
    get fileCompletion() { return fileCompletion },
    get historyMgr() { return historyMgr },
    get inputImageHistory() { return inputImageHistory },
    get insertPaste() { return insertPaste },
    get pastedChunks() { return pastedChunks },
    get pastedImages() { return pastedImages },
    get submit() { return submit },
    get tryPasteClipboard() { return tryPasteClipboard },
    get tryPasteImage() { return tryPasteImage },
    get withDraftImages() { return withDraftImages },
      get composer() { return composer },
      get cleanup() { return cleanup },
    get selectorKeys() { return selectorKeys },
    get suggestionInput() { return suggestionInput },
      get keys() { return keys },
    get terminalInput() { return terminalInput },
    get terminal() { return terminal },
  }
  const commandWindow = createCommandWindowController(st, host)
  const scrollback = createScrollbackController(st, host)
  const asks = createAskController(st, host)
  const frames = createFrameController(st, host)
  const cloudCtl = createCloudController(st, host)
  const sessionCtl = createSessionController(st, host)
  const idle = createIdleController(st, host)
  const suggest = createSuggestController(st, host)
  const runCtl = createRunController(st, host)
  const compaction = createCompactionController(st, host)
  const slashCtl = createSlashController(st, host)
  const submit = createSubmitController(st, host)
  const composer = createComposerController(st, host)
  const selectorKeys = createSelectorKeysController(st, host)
  const keys = createKeysController(st, host)
  const terminal = createTerminalController(st, host)

  const { agent } = opts
  const { version } = await import('../native/index.js')
  const appVersion = version()
  const rendererTrace = new RendererTrace()
  const sessionHook = new SessionHook({ cwd: agent.cwd, command: agent.configInfo().sessionHook })
  sessionHook.startProcess(agent.cwd)
  st.historyRowCount = 0
  // Created before the renderer so render diagnostics have a sink from the very
  // first frame; both are read only while rendering, which starts later.
  const screenLog = new ScreenLog()
  const renderDiagnostics = new RenderDiagnostics({
    log: lines => screenLog.logLines(lines),
    regions: () => ({ historyRows: st.historyRowCount, liveRegionStart: st.liveRegionStartRow }),
  })
  const renderer = new TermRenderer({
    trace: rendererTrace.isEnabled ? entry => rendererTrace.log(entry) : undefined,
    onDiagnostic: diagnostic => renderDiagnostics.record(diagnostic),
  })
  renderer.init()

  // The composer paints its own caret, so the idle blink is ours to drive.
  const resources = new ResourceScope()
  const backgroundJobs = new BackgroundScheduler()
  resources.add(() => backgroundJobs.dispose())
  const backgroundCleanup = new ResourceScope()
  // Armed by buildFrame only while visible text or its lifecycle needs a wakeup.
  const adSlotWakeup = new RenderWakeup(() => renderer.requestRender())

  st.appState = {
    ...createInitialState(agent.model, agent.cwd),
  }
  st.spinnerState = createSpinnerState()
  st.backgroundWaitSpinner = setSpinnerPhase(createSpinnerState(), 'awaiting_background')
  st.backgroundWaitSince = null
  st.manualCompactionPhase = null
  st.manualCompactionActivity = null
  st.editor = createEditorState()
  // Undo stack lives outside EditorState so snapshots stay plain data. Cleared
  // on submit/clear so a previous prompt cannot be restored into a new one.
  const editorUndo = new UndoStack<EditorState>()
  st.isLoading = false
  st.loginInFlight = false
  st.foregroundCommand = null
  st.streamRef = null
  // Native abort settles asynchronously. Ownership is revoked before aborting
  // so an old Promise cannot report twice or clear a newer run's state.
  const runInteraction = new RunInteraction()
  const runOwnership = new RunOwnership()
  st.runStartedAt = null
  st.runTurnCount = 0
  const runThinking = new RunThinking()
  const manualCompaction = new ManualCompaction()
  st.queueStartupTarget = { startup: 0 }
  st.pendingQueue = createPendingQueueState()
  const pendingQueue = new PendingQueue(st.pendingQueue)
  st.queueEditState = null
  st.draftEpoch = 0
  st.draftImageEpoch = 0
  st.pendingEnqueue = null
  st.queueDispatchId = null
  const queueLifecycle = createQueueLifecycle({
    queue: pendingQueue,
    getTarget: () => currentQueueTarget(st),
    getStream: () => st.streamRef,
    preparing: () => st.pendingEnqueue !== null || pendingImages.awaiting,
    editing: () => st.queueEditState !== null,
    busy: () => st.isLoading || manualCompaction.active || st.destroyed,
    getDispatch: () => st.queueDispatchId,
    setDispatch: id => { st.queueDispatchId = id },
    consumed: entries => {
      for (const entry of entries) scrollback.commitUserMessage(entry.text)
      const edit = st.queueEditState
      if (edit && entries.some(entry => entry.id === edit.entry.id)) edit.consumed = true
      renderer.requestRender()
    },
    notify: message => { scrollback.commitSystem('sys-queue', `  ${message}`); renderer.requestRender() },
    runQueued: async entry => {
      if (typeof entry.target === 'object' && entry.target !== null && !('startup' in entry.target)) {
        await slashCtl.runLogQuery(entry.target, entry.expandedText, entry.contentJson)
      } else {
        const extension = taskSession.followUpExtension(st.sessionId) ?? computeSession.followUpExtension(st.sessionId)
        await runCtl.runQuery(entry.expandedText, entry.contentJson, undefined, extension)
      }
    },
    requestRender: () => renderer.requestRender(),
  })
  const queueEdit = createQueueEdit({
    queue: pendingQueue, lifecycle: queueLifecycle,
    getTarget: () => currentQueueTarget(st),
    getEditing: () => st.queueEditState,
    setEditing: edit => { st.queueEditState = edit },
    snapshot: composer.snapshot,
    restore: composer.restore,
    preparing: () => st.pendingEnqueue !== null || pendingImages.awaiting,
    getEditor: () => st.editor,
    expand: text => promptInput(text, st.skillEntries),
    setOverlay: next => { st.overlay = next },
    commitSystem: scrollback.commitSystem,
    requestRender: () => renderer.requestRender(),
  })
  st.spinnerTimer = null
  const terminalTitle = new TerminalTitle(agent.cwd, () => ownedDashboardPort(st.serverState))
  const setTerminalTitle = terminalTitle.set.bind(terminalTitle)
  const freezeTerminalTitle = terminalTitle.freeze.bind(terminalTitle)
  st.shareSelector = null
  const loopSession = new LoopSession({
    runTurn: (userLine, prompt, extension) => {
      if (userLine) scrollback.commitUserMessage(userLine)
      void runCtl.runQuery(prompt, undefined, undefined, extension)
    },
    canWake: () => !st.isLoading && !st.destroyed && !st.pendingEnqueue
      && pendingQueue.visible(currentQueueTarget(st)).length === 0
      && st.overlay.kind !== 'ask-user',
    notify: text => scrollback.commitSystem('sys-loop', `  ${text}`),
    requestRender: () => renderer.requestRender(),
    // Read at wakeup time; `backgroundTerminals` is initialised further down
    // in this scope, long before the first wakeup can fire.
    backgroundTasks: () => backgroundTerminals.runningProcesses().map(process => ({
      taskId: process.task_id,
      command: process.command,
      elapsedMs: process.elapsed_ms,
    })),
    waitingChanged: waiting => {
      suggestions.cancelAutomatic()
      if (st.isLoading) return
      if (waiting) suggest.requestProductSuggestion('loop_waiting')
      sessionHook.state(waiting ? 'working' : 'idle')
      setTerminalTitle(idle.idleWaitTitle())
    },
  })
  resources.add(() => loopSession.dispose())

  const taskSession = new TaskSession({
    privacyStopped: stop => {
      scrollback.commitLines(buildPrivacyCard(stop))
      renderer.requestRender()
    },
    dimensions: () => ({ columns: renderer.termCols, rows: renderer.termRows }),
    envFile: opts.envFile,
    ensureDelivery: async signal => {
      const ask = (questions: AskQuestion[]) => asks.presentAskQuestions(questions, 'working', true)
      return ensureFeishuDelivery({
        signal, ask,
        consoleUrl: new URL('/feishu', st.serverState?.address ?? `http://127.0.0.1:${opts.serverPort ?? 8082}`).href,
        envFile: () => st.configInfo?.envPath,
        console: async () => {
          await backgroundJobs.trigger('dashboard')
          if (st.serverState) return st.serverState
          // Setup may explicitly inspect another console even when it is
          // not eligible for same-config Dashboard reuse.
          const address = `http://127.0.0.1:${opts.serverPort ?? 8082}`
          const snapshot = await inspectConsole(address)
          return { address, envFile: snapshot.env_file_path }
        },
        wait: (message, check, signal) => {
          const owner = Symbol('setup-wait')
          return waitForSetup({
            ask: questions => asks.presentAskQuestions(questions, 'working', true, owner),
            dismiss: () => {
              if (st.overlay.kind !== 'ask-user' || st.overlay.state.owner !== owner) return
              asks.resolvePendingAsk()
              st.overlay = { kind: 'none' }
              idle.unfreezeTerminalTitle()
              renderer.requestRender()
            },
          }, message, check, signal)
        },
      })
    },
    configInfo: () => st.configInfo,
    activeModelSpec: () => currentModelSpec(st.configInfo, agent.model),
    activeModel: () => agent.model,
    modelOptionLabel: formatModelOptionLabel,
    isTaskOverlay: () =>
      st.overlay.kind === 'selector' && st.overlay.state.owner === SELECTOR_OWNER.task,
    taskOverlayState: () =>
      st.overlay.kind === 'selector' && st.overlay.state.owner === SELECTOR_OWNER.task
        ? st.overlay.state
        : null,
    showSelector: state => { st.overlay = { kind: 'selector', state } },
    currentSessionId: () => st.sessionId,
    loadRunTranscript: async id => await agent.findSession(id) ? agent.loadTranscript(id) : null,
    closeOverlay: () => { st.overlay = { kind: 'none' } },
    requestRender: () => renderer.requestRender(),
    notifyError: text => scrollback.commitSystem('sys-task-err', renderErrorNotice(text)),
    notify: text => scrollback.commitSystem('sys-task', `  ${text}`),
    hyperlink: url => createHyperlink(url),
    collectAnswers: questions => asks.presentAskQuestions(questions, 'idle'),
    presentModelPicker: asks.presentTaskModelPicker,
    runTaskTurn: (userLine, prompt, extension) => {
      scrollback.commitUserMessage(userLine)
      runCtl.runQuery(prompt, undefined, undefined, extension)
    },
    primeInput: text => {
      composer.clearAll()
      st.editor = insertText(st.editor, text)
    },
    destroyed: () => st.destroyed,
  })
  const computeSession = new ComputeSession({
    dimensions: () => ({ columns: renderer.termCols, rows: renderer.termRows }),
    isComputeOverlay: () =>
      st.overlay.kind === 'selector' && st.overlay.state.owner === SELECTOR_OWNER.compute,
    computeOverlayState: () =>
      st.overlay.kind === 'selector' && st.overlay.state.owner === SELECTOR_OWNER.compute
        ? st.overlay.state
        : null,
    showSelector: state => { st.overlay = { kind: 'selector', state } },
    currentSessionId: () => st.sessionId,
    closeOverlay: () => { st.overlay = { kind: 'none' } },
    requestRender: () => renderer.requestRender(),
    notifyError: text => scrollback.commitSystem('sys-compute-err', renderErrorNotice(text)),
    notify: text => scrollback.commitSystem('sys-compute', `  ${text}`),
    collectAnswers: questions => asks.presentAskQuestions(questions, 'idle'),
    runComputeTurn: (userLine, prompt, extension) => {
      scrollback.commitUserMessage(userLine)
      runCtl.runQuery(prompt, undefined, undefined, extension)
    },
    cwd: () => agent.cwd,
    destroyed: () => st.destroyed,
  })
  const taskIdentity = new AuthIdentityTracker(() => taskSession.resetIdentity())
  const shareNotices = new ShareNotices((sid, notices) => agent.recordShareNotices(sid, notices))
  const cloudSessions = new CloudSessionSync({
    indexUpdated: () => st.refreshOpenSessionList?.(),
    push: (sid, force) => agent.cloudPushSession(sid, force),
    list: () => agent.cloudListSessions(),
    notify: (text, level) => {
      if (st.destroyed) return
      scrollback.commitSystem('sys-cloud-sync', level === 'error' ? chalk.dim(`  ${text}`) : `  ${text}`)
      renderer.requestRender()
    },
    privacyStopped: (_sid, stop) => {
      if (st.destroyed) return
      scrollback.commitLines(buildPrivacyCard(stop))
      renderer.requestRender()
    },
  })
  resources.add(() => cloudSessions.dispose())
  const sessionCloudLabel = (session: SessionMeta) =>
    cloudLabel(cloudSessions.stateFor(session), session.cloud?.visibility, session.cloud?.team)
  const replCommands: ReplCommandContext = {
    agent,
    flushShareNotices: () => shareNotices.flush(),
    isBusy: () => st.isLoading,
    // `/share` is the sessions list narrowed to cloud rows: one list, one
    // set of keys, rather than a second selector to learn.
    openShareList: async () => { sessionCtl.invalidateResumeSessionCache(); sessionCtl.openResumeSelector(undefined, { cloudOnly: true }) },
    openShareLinks: sessionCtl.openShareLinks,
    cloudAcknowledged: (sid, result) => {
      cloudSessions.acknowledge(sid, result)
      sessionCtl.invalidateResumeSessionCache()
      if (sid === st.sessionId) void sessionCtl.refreshForkTrail(sid).then(() => renderer.requestRender())
    },
    cloudForgotten: sid => {
      cloudSessions.forget(sid)
      sessionCtl.invalidateResumeSessionCache()
      if (sid === st.sessionId) void sessionCtl.refreshForkTrail(sid).then(() => renderer.requestRender())
    },
    resumeSession: session => sessionCtl.resumeSession(session),
    getSessionId: () => st.sessionId,
    getCompactLines: () => compactLines,
    getConfigInfo: () => st.configInfo ?? null,
    commitSystem: scrollback.commitSystem,
    commitRevealed: scrollback.commitRevealed,
    commitLines: scrollback.commitLines,
    replaceLine: (id, text) => committer.replaceById(id, text),
    columns: () => renderer.termCols,
    requestRender: () => renderer.requestRender(),
  }
  st.destroyed = false
  st.composerRevision = 0
  st.suggestionContextId = 0
  const suggestionContext = new SuggestionContext()
  // What masking did this process, shown as it happens.
  const privacyFeed = new PrivacyFeed(privacyLive)
  st.suggestionsReady = false
  st.startupSuggestion = null
  const suggestionTicker = new SuggestionTicker({
    pending: () => suggestions.pending(),
    changed: () => renderer.requestRender(),
  })
  const suggestions = new PromptSuggestion({
    // Only session/mode/composer changes invalidate explicit input assistance;
    // foreground run ownership and progress are deliberately not part of it.
    key: () => `${st.suggestionContextId}:${!!st.logMode}`,
    eligible: suggest.suggestionInputReady,
    automaticEligible: suggest.automaticSuggestionEligible,
    context: () => suggestionContext.snapshot(suggest.liveWorkflowRuntime()),
    validate: text => validCommandInput(text, suggest.suggestionInventory),
    identity: text => commandIdentity(text, suggest.suggestionInventory),
    allowsCommand: text => allowedSuggestionCommand(text, suggest.composerPolicy().allowedCommands),
    start: (messages, given) => {
      const hints = { ...given, session: st.sessionId ?? undefined }
      const draft = (hints.draft ?? '') + (hints.suffix ?? '')
      if (!parsePasteRefs(draft).some(ref => ref.type === 'image')) return agent.suggestNextPrompt(messages, hints)
      return prepareSuggestion(async signal => {
        const images = await suggestionImages(draft, pastedImages, pendingImages, signal)
        signal.throwIfAborted()
        if (getEditorText(st.editor) !== draft || editorCursorOffset(st.editor) !== (hints.draft?.length ?? 0)) throw new Error('Suggestion input changed')
        return agent.suggestNextPrompt(messages, { ...hints, images })
      })
    },
    draft: () => getEditorText(st.editor),
    cursor: () => editorCursorOffset(st.editor),
    changed: () => { suggestionTicker.sync(); renderer.requestRender() },
    // Automatic sampling is otherwise invisible; a rejected key would stay
    // silent for days. Say it once, then pause until credentials change.
    unauthorized: () => scrollback.commitSystem('sys-suggestion-auth',
      chalk.dim('  Inline suggestions paused: the suggestion service rejected its key. /login refreshes it; ⇥ retries.')),
  })
  const suggestionTaskWait = new TaskWaitSuggestion(suggestions)
  const suggestionInput = createSuggestionInput({
    controller: suggestions,
    eligible: suggest.suggestionInputReady,
    editor: () => st.editor,
    replace: text => composer.mutateEditor(state => replaceAfterCursor(state, text)),
    changed: () => renderer.requestRender(),
    dismissed: () => runInteraction.clear(),
    inventory: suggest.suggestionInventory,
    skills: () => st.skillEntries,
    showArguments: completion => { st.editor = showCompletions(st.editor, completion.items, completion.start, completion.end, completion.note) },
  })
  resources.add(() => { suggestions.cancel(); suggestionTicker.dispose() })
  st.terminalSuspended = false
  st.disableRaw = null
  st.enhancedKeyboard = null
  st.inputBuffer = null
  st.onInputData = null
  st.sessionId = null
  st.lastLineage = []
  st.nextBackgroundLineId = 1
  st.logMode = null
  st.logDiscardTarget = null
  st.exitHint = false
  st.exitHintTimer = null
  st.overlay = { kind: 'none' }
  st.commandWindowPreview = null
  st.commandWindowPreviewGeneration = 0
  st.focusedCommandWindowGeneration = null
  st.commandWindowContentLines = null
  st.commandWindowContentWidth = null
  st.deferredCloudModelNotice = null
  st.deferredCloudCampaignId = null
  st.deferredSkillNotice = null
  st.enrichedResumeMetadataGeneration = null
  st.enrichedResumeTextGeneration = null
  st.cancelSearchTextWarmup = null
  st.preloadedSessions = []
  const resumeCache = new ResumeSessionCache(agent, rows => { st.preloadedSessions = rows })
  resources.add(() => resumeCache.dispose())
  // Reuses formatted rows across the rekey that every `/sessions` keystroke
  // performs, which also preserves the selector's lowercased-search cache.
  const resumeItems = new ResumeItemCache()
  resources.add(() => resumeItems.clear())
  st.explicitResumeSelectorGeneration = 0
  st.pendingAsk = null
  st.pendingTaskModel = null

  st.streamMachine = null
  st.skillEntries = getSkillEntries(agent.skillsDirs())
  st.expanded = false
  // Rendered-history cache — see HistoryRenderCache. Committed history is
  // append-only (or fully cleared), never mutated in place, so the flattened
  // ANSI lines are extended incrementally instead of re-flattened every frame.
  // A full rebuild over a long session takes 5–14 ms, which is what made the
  // just-sent message and keystroke echo visibly stall as the conversation
  // grew. Compact and expanded views each get their own cache because their
  // source arrays are appended independently (expanded-only progress/thinking).
  const compactHistoryCache = new HistoryRenderCache()
  const expandedHistoryCache = new HistoryRenderCache()
  st.committedBannerRows = null
  st.committedHistoryRows = 0
  st.committedPrefixMayReshape = false

  st.unmountTaskPreview = null
  st.unmountComputePreview = null
  const compactLines: OutputLine[] = []
  const expandedLines: OutputLine[] = []
  const fileCompletion = new FileCompletion(completeAtFile)
  resources.add(() => fileCompletion.dispose())
  const committer = new Committer({
    compactLines,
    expandedLines,
    isExpanded: () => st.expanded,
    columns: () => renderer.termCols,
    logLines: lines => screenLog.logLines(lines),
    notices: lines => shareNotices.record(st.sessionId, lines),
    requestRender: () => renderer.requestRender(),
    invalidateHistory: () => {
      frames.resetHistoryCache()
      // An in-place edit (erasing a revealed secret) must reach scrollback too.
      renderer.invalidateScrollback()
    },
  })
  st.liveContentMaxHeight = 0
  st.liveContentWidth = renderer.termCols
  st.liveRegionStartRow = 0

  st.serverState = null

  // Paste ref state
  const pasteStore = createPasteStore()
  const { chunks: pastedChunks, images: pastedImages } = pasteStore
  // Images whose bytes are still being extracted. The ref is already visible in
  // the composer, so a submit has to await these before reading pastedImages.
  const pendingImages = new PendingImages()

  st.updateAvailable = null
  st.updateStatus = 'idle'
  st.updateVersion = null
  const updateMgr = new (await import('../update/index.js')).UpdateManager(
    appVersion
  )
  updateMgr.on('update-available', (info: { version: string }) => {
    st.updateAvailable = { version: info.version }
    renderer.requestRender()
  })
  updateMgr.on('update-status', (status: { kind: 'idle' | 'downloading' | 'staged'; version?: string }) => {
    st.updateStatus = status.kind
    st.updateVersion = status.version ?? null
    renderer.requestRender()
  })
  {
    // A download staged by a previous session must show before the first
    // network check runs, so seed from disk alongside the manager's own read.
    const initial = updateMgr.getStatus()
    if (initial.kind !== 'idle') {
      st.updateStatus = initial.kind
      st.updateVersion = initial.version
    }
  }
  updateMgr.start()

  st.installDrift = null
  try {
    const { checkInstallHealth } = await import('../update/state.js')
    const health = checkInstallHealth(appVersion)
    if (health.kind === 'drift') st.installDrift = health.reason
    // A newer version is already installed on disk while this session keeps the
    // image it started with. That is the staged-update state as far as the user
    // is concerned — reuse the restart notice instead of warning about a
    // mismatch and sending them to /update, which would reinstall for nothing.
    if (health.kind === 'restart_required') {
      st.updateStatus = 'staged'
      st.updateVersion = health.installedVersion
    }
  } catch { /* best effort */ }

  const historyMgr = new HistoryManager(agent.cwd)
  const inputImageHistory = new InputImageHistory()
  const entries = historyMgr.load().map(text => inputImageHistory.deserialize(text, () => pasteStore.allocId()))
  st.historyState = createHistoryState(entries)

  st.cloudLoginRequired = false
  st.revocationCleanup = null
  st.authWatcher = null
  const refreshConfigInfo = () => {
    // Re-read backend config after a model switch so the footer reflects the
    // new provider's effective thinking level (it can differ per provider).
    try { st.configInfo = agent.configInfo() } catch {}
  }
  refreshConfigInfo()

  const premiumAccount = hasPremiumModel(st.configInfo)
  st.adSlot = createAdSlotState(
    campaignContent(authNotices()),
    { premium: premiumAccount },
  )
  // Logged-in users see the slot from the start — no need to wait for a
  // task to finish. The live sync below refreshes content first.
  if (st.adSlot.notices.length > 0 || st.adSlot.ads.length > 0) {
    triggerAdSlot(st.adSlot, Date.now())
  }

  if (shouldPreloadStartupSessions(opts)) {
    try {
      st.preloadedSessions = await agent.listSessions(opts.continueLatest || opts.forkFrom ? 0 : 20)
      resumeCache.replace(st.preloadedSessions, Boolean(opts.continueLatest))
    } catch {}
  }

  // Git info is watched so the footer follows external `git switch` / checkout
  // operations without requiring a REPL restart.
  const gitInfo = new GitInfoProvider(agent.cwd)
  gitInfo.onChange(() => renderer.requestRender())

  setTerminalTitle('✳')

  if (opts.forkFrom) {
    const wanted = opts.forkFrom.sessionId
    const source = wanted
      ? st.preloadedSessions.find(s => s.session_id === wanted || s.session_id.startsWith(wanted))
      : findPreviousSession(st.preloadedSessions, agent.cwd)
    if (!source) {
      scrollback.commitSystem('sys-fork-err', renderErrorNotice(wanted ? `Session not found: ${wanted}` : 'No session in this directory to fork'))
      cleanup()
      await sessionHook.close()
      fastExit(1)
    } else {
      try {
        const fork = await agent.forkSession(source.session_id)
        await sessionCtl.resumeSession(fork, forkNotice(fork, source, chalk.dim, chalk.cyan))
      } catch (err) {
        scrollback.commitSystem('sys-fork-err', renderErrorNotice(`Fork failed: ${errorText(err)}`))
      }
    }
  } else if (opts.continueLatest) {
    const match = findPreviousSession(st.preloadedSessions, agent.cwd)
    if (match) {
      await sessionCtl.resumeSession(match)
    } else {
      scrollback.commitSystem('sys-continue-err', renderErrorNotice('No conversation found to continue'))
      cleanup()
      await sessionHook.close()
      fastExit(1)
    }
  } else if (opts.resumeSessionId) {
    const match = st.preloadedSessions.find(
      (s) => s.session_id === opts.resumeSessionId || s.session_id.startsWith(opts.resumeSessionId!)
    )
    if (match) {
      await sessionCtl.resumeSession(match)
    } else {
      scrollback.commitSystem('sys-resume-err', renderErrorNotice(`Session not found: ${opts.resumeSessionId}`))
    }
  }

  renderer.requestRender()

  st.releaseNotes = null
  try {
    const { markReleaseNotesSeen, releaseNotesPending } = await import('../update/seen-version.js')
    if (releaseNotesPending(appVersion)) {
      const { parseReleaseNotes } = await import('../update/notes.js')
      const { fetchReleaseNotesFor } = await import('../update/check.js')
      // Notes for the build that is running, not whatever is newest. Keep the
      // version pending when offline; only a matching release record proves the
      // metadata was handled and may be marked seen.
      fetchReleaseNotesFor(appVersion).then((info) => {
        if (!info) return
        markReleaseNotesSeen(appVersion)
        if (info.body) {
          st.releaseNotes = parseReleaseNotes(info.body)
          renderer.requestRender()
        }
      }).catch(() => {})
    }
  } catch { /* best effort */ }

  const bannerCache = new BannerCache(agent.cwd, agent.skillsDirs())
  // Catch edits made by other sessions without filesystem work in buildFrame.
  resources.add(backgroundJobs.register({ name: 'banner', intervalMs: 15_000, immediate: false, run: frames.refreshBannerData }))
  st.partialBlocksMemo = null

  renderer.setRenderCallback(frames.buildFrame)

  st.titleFrame = 0

  const backgroundTerminals = new BackgroundTerminals({
    columns: () => renderer.termCols,
    rows: () => renderer.termRows,
    client: agent,
    sessionId: () => st.sessionId,
    commit: scrollback.commitBackgroundLine,
    requestRender: () => renderer.requestRender(),
    errorText,
    paintError: text => renderErrorNotice(text.trimStart()),
    readOutput: path => readOutputTail(path),
    watchOutput: watchOutputFile,
    openPanel: state => {
      st.overlay = { kind: 'selector', state }
      renderer.requestRender()
    },
    updatePanel: state => {
      // Only ever touch the overlay while the panel owns it: an async stop
      // landing after the user moved on must not close a different overlay.
      if (st.overlay.kind !== 'selector' || !isBackgroundSelector(st.overlay.state)) return
      st.overlay = state ? { kind: 'selector', state } : { kind: 'none' }
      renderer.requestRender()
    },
    panelOpen: () => st.overlay.kind === 'selector' && isBackgroundSelector(st.overlay.state),
    panelState: () =>
      st.overlay.kind === 'selector' && isBackgroundSelector(st.overlay.state) ? st.overlay.state : null,
    // A run drains the notification queue itself between turns, so waking is
    // only for the idle case.
    runInFlight: () => st.isLoading,
    queuedMessages: () => pendingQueue.visible(currentQueueTarget(st)).length,
    // An ask overlay is the agent waiting on the user: seizing the turn would
    // answer a question they have not answered yet.
    overlayBlocking: () => st.overlay.kind === 'ask-user',
    awaitedTaskIds: () => st.isLoading
      ? awaitedTaskIds(assistantToolCalls(st.streamMachine?.appState.currentAssistantContent ?? []))
      : [],
    wakeForNotifications: () => {
      // No text: build_turn puts the queued completion notices into this turn's
      // input, so a synthetic prompt would duplicate what the model just read.
      // Fire-and-forget because the poll cannot await; runQuery owns its own
      // lifecycle and errors from here.
      void runCtl.runQuery('')
    },
  })

  backgroundCleanup.add(() => backgroundTerminals.killAllNow())
  resources.add(idle.startIdleWaitTimer())

  const {
    insertPaste,
    tryPasteImage,
    tryPasteClipboard,
    withDraftImages,
    buildImageContentBlocks,
  } = createPasteHandlers({
    store: pasteStore,
    pendingImages,
    getEditor: () => st.editor,
    mutateEditor: composer.mutateEditor,
    isDestroyed: () => st.destroyed,
    ownership: () => st.draftImageEpoch,
    notify: message => scrollback.commitSystem('sys-image-error', `  ${message}`),
    requestRender: () => renderer.requestRender(),
    getDisplayText: composer.getDisplayText,
    getExpandedText: composer.getExpandedText,
  })

  st.inflightSync = null
  const CLOUD_SYNC_MS = 15_000
  const cloudSync = new CloudSync({
    authenticated: async () => {
      const { authWhoami } = await import('../native/index.js')
      return Boolean(await authWhoami())
    },
    // The signed-in slot is driven by the account catalog, not the public
    // /v1/notices list. The catalog already includes every campaign this
    // account matches (everyone, premium, group); the public list is only the
    // everyone subset. Feeding it in here replaced the showing notice with
    // that subset and restarted the ticker every sync.
    syncNotices: async () => [],
    syncModels: async () => {
      const { authSyncModels } = await import('../native/index.js')
      return authSyncModels()
    },
    noticesUpdated: () => {},
    modelsUpdated: () => {
      st.authWatcher?.sync()
      cloudCtl.reloadCloudContent()
    },
  }, CLOUD_SYNC_MS)
  resources.add(() => cloudSync.dispose())
  resources.add(backgroundJobs.register({ name: 'cloud-sync', intervalMs: CLOUD_SYNC_MS, initialDelayMs: 400, run: () => cloudCtl.syncCloudNow() }))
  resources.add(backgroundJobs.register({ name: 'processes', intervalMs: 500, immediate: false, run: idle.refreshBackgroundProcesses }))
  resources.add(backgroundJobs.register({ name: 'tasks', intervalMs: 10_000, immediate: false, run: () => taskSession.refreshIfVisible() }))
  // Official skills follow their catalog on their own: a stamp-gated check on
  // the same cadence as the check itself, so a fresh launch and a session left
  // open for days both stay current without anyone running /skill update.
  // Skills are re-read from disk on every turn, so a sync needs no reload.
  resources.add(backgroundJobs.register({
    name: 'official-skills',
    intervalMs: OFFICIAL_SYNC_INTERVAL_MS,
    initialDelayMs: 1_500,
    run: async () => {
      const outcome = await startOfficialSkillMaintenance()
      if (outcome.kind === 'synced' && !st.destroyed) cloudCtl.noteOfficialSkillSync(outcome.result)
    },
  }))
  resources.add(registerDashboard(backgroundJobs, {
    attempt: () => tryStartServer(opts.serverPort, st.configInfo?.envPath ?? opts.envFile),
    stop: stopOwnedServer,
    publish: state => {
      const changed = st.serverState?.address !== state?.address || st.serverState?.owned !== state?.owned
      st.serverState = state
      if (changed && !st.destroyed) {
        frames.refreshBannerData()
        terminalTitle.refresh()
        renderer.requestRender()
      }
    },
  }))

  st.authWatcher = new AuthWatcher(() => cloudCtl.adoptExternalAuthChange())

  // Any server-pushed group counts, not just the free tier, so granted
  // models and split protocol groups are announced too.
  const cloudModels = () => st.configInfo?.availableModels.filter(isCloudModel) ?? []
  const modelAnnouncer = new ModelAnnouncer()
  modelAnnouncer.seed(cloudModels().map(m => m.model))

  const terminalInput = new TerminalInputBuffer({
    onEmptyPaste: tryPasteImage,
    onControl: terminal.handleTerminalControl,
  })
  st.inputBuffer = terminalInput
  terminal.start()
  st.suggestionsReady = true
  if (st.startupSuggestion) { const trigger = st.startupSuggestion; st.startupSuggestion = null; suggest.requestProductSuggestion(trigger) }
  renderer.requestRender()

  function cleanup() {
    if (st.destroyed) return
    st.destroyed = true
    taskSession.dispose()
    computeSession.dispose()
    st.pendingEnqueue = null
    pendingQueue.cancelReservation()
    asks.resolvePendingTaskModel()
    idle.unfreezeTerminalTitle()
    manualCompaction.abort()
    st.streamRef?.abort()
    runCtl.stopSpinner()
    adSlotWakeup.dispose()
    resources.dispose()
    st.authWatcher?.dispose()
    st.authWatcher = null
    gitInfo.dispose()
    updateMgr.cleanup()
    if (st.exitHintTimer) clearTimeout(st.exitHintTimer)
    commandWindow.cancelCommandWindowLoads()
    commandWindow.cancelResumeSearchEnrichment()
    sessionCtl.invalidateExplicitResumeSelector()
    commandWindow.cancelSearchTextWarm()
    committer.flushReveals()
    terminal.stop()
    st.inputBuffer = null
    setTerminalTitle()
    renderer.destroy()
    rendererTrace.close()
    // Every exit path ends in fastExit, which skips Rust Drop impls and async
    // teardown. Background children live in their own process groups, so they
    // would survive as orphans unless signalled synchronously right here.
    // The controller absorbs its own failures: cleanup must never throw.
    backgroundCleanup.dispose()
    const pendingCount = st.pendingQueue.entries.length
    if (pendingCount > 0) process.stderr.write(`\n  Discarding ${pendingCount} pending prompt${pendingCount === 1 ? '' : 's'}; the queue is not persisted.\n`)
  }

  function restartAfterCleanup(): void {
    cleanup()
    void sessionHook.close().then(async () => {
      const { execIntoInstalledRestart } = await import('../update/index.js')
      execIntoInstalledRestart(st.sessionId)
      // Handover only returns when execve was impossible (source checkout,
      // Windows, missing binary). Fall back to a normal exit so the user can
      // relaunch from the shell instead of sitting in a dead TUI.
      fastExit(0)
    })
  }

  // Declared as a function so the earlier exit paths (Ctrl-D, /exit, the exit
  // control action) can call it without hitting a `const` TDZ error: they run
  // from callbacks defined above this point in `startRepl`.
  function exitAfterCleanup(code: number): void {
    cleanup()
    void sessionHook.close().then(() => fastExit(code))
  }

  process.on('SIGINT', () => { exitAfterCleanup(130) })
  process.on('SIGTERM', () => { exitAfterCleanup(143) })

  await new Promise<void>(() => {})
}
