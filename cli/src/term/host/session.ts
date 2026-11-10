import chalk from 'chalk'
import type { ComputeSession } from '../../features/compute/session.js'
import type { HostToolExtension } from '../../features/host-tools.js'
import type { LoopSession } from '../../features/loop/session.js'
import { carryModelEfforts, currentModelSpec, modelOptions, modelSelectorItems } from '../../features/models/options.js'
import { refreshTaskModelWindow } from '../../features/task/model-picker.js'
import type { TaskSession } from '../../features/task/session.js'
import { type Agent, type QueryStream, type SessionMeta, privacySessionTags } from '../../native/index.js'
import type { OutputLine } from '../../render/output.js'
import { type CloudSessionSync, cloudBadge, mergeRemoteSessions } from '../../session/cloud-sessions.js'
import type { SessionHook } from '../../session/hook.js'
import { formatRankedSessionItems, formatSessionItems, isInteractiveSession, shortenSessionCwd } from '../../session/resume.js'
import { reloadResumeModel, resumeElidedLine, selectResumeMessages } from '../../session/session-view.js'
import type { SuggestionTrigger } from '../app/composer/composer-guidance.js'
import type { PrivacyFeed } from '../app/privacy-feed.js'
import { createModelWindow } from '../app/selector/selector-windows.js'
import { backNotice, forkNotice, resolveBackTarget } from '../app/session/fork-nav.js'
import { prepareResume } from '../app/session/prepare-resume.js'
import type { ResumeSessionCache } from '../app/session/resume-cache.js'
import { lastAssistantText, parseSessionSearchResults } from '../app/session/session-search.js'
import { ShareSelector } from '../app/session/share-selector.js'
import type { SuggestionContext } from '../app/suggestion/context.js'
import type { PromptSuggestion } from '../app/suggestion/index.js'
import type { RendererTrace } from '../diagnostics/renderer-trace.js'
import type { CommandWindowController } from './command-window.js'
import type { FrameController } from './frame.js'
import type { ScrollbackController } from './scrollback.js'
import type { ReplState } from './state.js'
import { setGhostHintContext } from '../input/editor.js'
import { openWebLink } from '../open-link.js'
import type { TermRenderer } from '../screen/renderer.js'
import { forkTrailTitles } from '../viewmodel/fork-trail.js'
import { renderErrorNotice } from '../../ui/command-notice.js'
import { errorText } from '../../ui/format.js'
import { SELECTOR_OWNER } from '../../ui/selector-identity.js'
import { type SelectorState, selectorExpandItems } from '../../ui/selector.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface SessionDeps {
  readonly agent: Agent
  readonly cloudSessions: CloudSessionSync
  readonly commandWindow: CommandWindowController
  readonly compactLines: OutputLine[]
  readonly computeSession: ComputeSession
  readonly expandedLines: OutputLine[]
  readonly frames: FrameController
  readonly loopSession: LoopSession
  readonly privacyFeed: PrivacyFeed
  readonly refreshConfigInfo: () => void
  readonly renderer: TermRenderer
  readonly rendererTrace: RendererTrace
  readonly requestProductSuggestion: (trigger: SuggestionTrigger) => void
  readonly resumeCache: ResumeSessionCache
  readonly runQuery: (text: string, contentJson?: string | undefined, prebuiltStream?: QueryStream | undefined, hostToolExtension?: HostToolExtension | undefined) => Promise<void>
  readonly scrollback: ScrollbackController
  readonly sessionCloudLabel: (session: SessionMeta) => string
  readonly sessionHook: SessionHook
  readonly suggestionContext: SuggestionContext
  readonly suggestions: PromptSuggestion
  readonly taskSession: TaskSession
}

export interface SessionController {
  readonly handleBackCommand: (levels: string) => Promise<void>
  readonly handleForkCommand: (title: string) => Promise<void>
  readonly handleSessionSearch: (args: string) => Promise<void>
  invalidateExplicitResumeSelector(): void
  invalidateResumeSessionCache(): void
  openModelSelector(): void
  openResumeSelector(initialQuery?: string | undefined, options?: { cloudOnly?: boolean | undefined; includeAutomation?: boolean | undefined; }): void
  readonly openShareLinks: () => Promise<void>
  readonly refreshForkTrail: (id: string) => Promise<SessionMeta[]>
  refreshOpenModelSelector(): boolean
  readonly resumeSession: (session: SessionMeta, notice?: OutputLine[] | undefined) => Promise<void>
}

/** Session navigation: resume, fork and back, the resume and model selectors, session search. */
export function createSessionController(st: ReplState, deps: SessionDeps): SessionController {
  /** Drop snapshots after a run changes session visibility, title, or recency. */
  function invalidateResumeSessionCache(): void {
    deps.resumeCache.invalidate()
    st.enrichedResumeMetadataGeneration = null
    st.enrichedResumeTextGeneration = null
    deps.commandWindow.cancelSearchTextWarm()
  }

  function invalidateExplicitResumeSelector(): void {
    st.explicitResumeSelectorGeneration++
    st.refreshOpenSessionList = undefined
  }

  /** Load the fork ancestry for the footer breadcrumb. Never fatal: a failed
   *  lookup just shows the session as a root. */
  async function refreshForkTrail(id: string): Promise<SessionMeta[]> {
    let lineage: SessionMeta[] = []
    try { lineage = await deps.agent.sessionLineage(id) } catch {}
    if (st.sessionId !== id) return lineage
    st.lastLineage = lineage
    setGhostHintContext({ forked: lineage.length > 1 })
    const cloud = lineage.find(meta => meta.session_id === id)?.cloud
    st.appState = {
      ...st.appState,
      forkTrail: forkTrailTitles(lineage),
      cloudBadge: cloud ? cloudBadge('synced', cloud.visibility, cloud.team) : '',
    }
    return lineage
  }

  /** Switch to `session`. `notice` replaces the default `resumed session`
   *  line when the switch is a fork or a `/back`. */
  /**
   * A cloud session may have moved on another machine: catch the local copy
   * up before the transcript is read. Divergence is not resolved here; the
   * local copy is resumed and the choice is spelled out.
   */
  async function pullBeforeResume(sessionId: string): Promise<OutputLine[]> {
    const remote = deps.cloudSessions.remoteFor(sessionId)
    if (!remote) return []
    const local = (deps.resumeCache.metadata ?? []).find(row => row.session_id === sessionId)
    const state = deps.cloudSessions.stateFor(local, sessionId)
    if (state !== 'remote_only' && state !== 'pull_pending' && state !== 'diverged') return []
    const result = await deps.agent.cloudPullSession(sessionId)
    invalidateResumeSessionCache()
    switch (result.kind) {
      case 'pulled':
        return [{ id: 'sys-cloud-pulled', kind: 'system', text: chalk.dim(`  ☁ pulled ${result.appended} entries from cloud${remote.origin_host ? ` (${remote.origin_host})` : ''}`) }]
      case 'diverged':
        return [{ id: 'sys-cloud-diverged', kind: 'system', text: chalk.yellow(`  ☁! changed on both machines · resumed local. /share cloud takes the cloud copy · /share local overwrites it with this one`) }]
      default:
        return []
    }
  }

  async function resumeSession(session: SessionMeta, notice?: OutputLine[]) {
    const revision = ++st.composerRevision
    st.suggestionContextId++
    deps.suggestions.cancel()
    deps.taskSession.cancelFlow()
    deps.computeSession.cancelFlow()
    deps.loopSession.reset()
    try {
      const cloudNotice = await pullBeforeResume(session.session_id)
      const { transcript, model, provider, thinkingLevel, cwd: sessionCwd } = await prepareResume(deps.agent, session)
      if (revision !== st.composerRevision || st.destroyed) return

      // Restore model selection from current config, then the session's
      // recorded thinking level (session wins over the config default).
      // Missing saved selections keep the refreshed live model and show a
      // recovery hint.
      const modelRestoreNote = reloadResumeModel(deps.agent, model, provider, thinkingLevel)
      st.sessionId = session.session_id
      deps.sessionHook.startSession(session.session_id, deps.agent.cwd)
      deps.sessionHook.state('idle')
      deps.rendererTrace.bind(session.session_id)
      deps.refreshConfigInfo()
      st.appState = { ...st.appState, sessionId: session.session_id, model: deps.agent.model }
      const { messagesToOutputLines } = await import('../../render/output.js')
      const { transcriptToMessages } = await import('../../session/transcript.js')
      const messages = transcriptToMessages(transcript)
      deps.suggestionContext.restore(transcript)
      // The history was masked in earlier processes; its placeholders are not
      // news. Best effort: without them the first card over-reports once.
      deps.privacyFeed.forget(session.session_id)
      void privacySessionTags(session.session_id).then(tags => deps.privacyFeed.seed(session.session_id, tags)).catch(() => {})
      deps.renderer.clearScreen()
      deps.compactLines.length = 0
      deps.expandedLines.length = 0
      deps.frames.resetHistoryCache()
      // Only render the most recent messages to scrollback. Rendering the whole
      // transcript re-runs markdown (marked lex + ANSI + table align) per
      // message, which is O(total) and reaches ~500ms on very long sessions.
      // The hidden messages stay in the model's context (the backend restores
      // it by session_id independently of this display transcript), so this
      // only trims what's painted, not what the model remembers.
      const { shown, hidden } = selectResumeMessages(messages)
      if (hidden > 0) deps.scrollback.restoreLines([resumeElidedLine(hidden)])
      deps.scrollback.restoreLines(messagesToOutputLines(shown), messagesToOutputLines(shown, true))
      deps.scrollback.restoreLines([
        { id: 'sys-resumed-gap', kind: 'system', text: '' },
        ...(notice ?? [{ id: 'sys-resumed', kind: 'system' as const, text: chalk.dim(`  resumed session ${session.session_id.slice(0, 8)}`) }]),
        ...cloudNotice,
      ])
      await refreshForkTrail(session.session_id)
      if (revision !== st.composerRevision || st.destroyed) return
      if (sessionCwd && sessionCwd !== deps.agent.cwd) {
        deps.scrollback.restoreLines([{
          id: 'sys-resume-cwd',
          kind: 'system',
          text: chalk.dim(`  session cwd: ${shortenSessionCwd(sessionCwd)} · working cwd remains: ${shortenSessionCwd(deps.agent.cwd)}`),
        }])
      }
      if (modelRestoreNote) {
        deps.scrollback.restoreLines([{ id: 'sys-resume-model', kind: 'system', text: chalk.dim(modelRestoreNote) }])
      }
      if (revision === st.composerRevision) deps.requestProductSuggestion('resume')
    } catch (err) {
      deps.scrollback.commitSystem('sys-err', `Failed to resume: ${errorText(err)}`, 'error')
    }
  }

  /** `/fork [title]`: copy the current context into a new session and move there. */
  async function handleForkCommand(title: string) {
    if (!st.sessionId) {
      deps.scrollback.commitSystem('sys-fork-none', chalk.dim('  Nothing to fork yet: send a message first.'))
      return
    }
    try {
      const parent = (await deps.agent.sessionLineage(st.sessionId)).at(-1) ?? ({ session_id: st.sessionId } as SessionMeta)
      const fork = await deps.agent.forkSession(st.sessionId, title.trim() || undefined)
      invalidateResumeSessionCache()
      await resumeSession(fork, forkNotice(fork, parent, chalk.dim, chalk.cyan))
    } catch (err) {
      deps.scrollback.commitSystem('sys-fork-err', renderErrorNotice(`/fork failed: ${errorText(err)}`))
    }
  }

  /** `/back [levels | root]`: resume an ancestor along the fork chain. */
  async function handleBackCommand(levels: string) {
    if (!st.sessionId) {
      deps.scrollback.commitSystem('sys-back-none', chalk.dim('  Not in a session.'))
      return
    }
    try {
      const lineage = await refreshForkTrail(st.sessionId)
      const resolved = resolveBackTarget(lineage, levels)
      if (resolved.kind === 'root') {
        deps.scrollback.commitSystem('sys-back-root', chalk.dim('  Already at the root session.  /sessions lists the others.'))
        return
      }
      if (resolved.kind === 'invalid') {
        deps.scrollback.commitSystem('sys-back-arg', chalk.dim(`  /back takes a level count, e.g. /back 2 (got "${resolved.levels}").`))
        return
      }
      const left = lineage[lineage.length - 1]
      if (!left) return
      invalidateResumeSessionCache()
      await resumeSession(resolved.target, backNotice(left, resolved.target, resolved.skipped, chalk.dim, chalk.cyan))
    } catch (err) {
      deps.scrollback.commitSystem('sys-back-err', renderErrorNotice(`/back failed: ${errorText(err)}`))
    }
  }

  function openModelSelector(): void {
    st.overlay = { kind: 'selector', state: createModelWindow(st.configInfo, deps.agent.model, true) }
  }

  /** Swap an open model catalog in place after a cloud refresh. Both the live
   *  /model picker and the Task-scoped picker keep their query, focused row,
   *  and adjusted effort; Task ownership remains separate from the session. */
  function refreshOpenModelSelector(): boolean {
    if (st.overlay.kind === 'selector' && st.overlay.state.owner === SELECTOR_OWNER.taskModel) {
      st.overlay = {
        kind: 'selector',
        state: refreshTaskModelWindow(st.overlay.state, st.configInfo, deps.agent.model),
      }
      return true
    }
    const models = modelOptions(st.configInfo, deps.agent.model)
    const activeSpec = currentModelSpec(st.configInfo, deps.agent.model)
    const rebuilt = () => modelSelectorItems(models, activeSpec, st.configInfo?.thinkingLevel, st.configInfo?.defaultModel)
    if (st.overlay.kind === 'selector' && st.overlay.state.owner === SELECTOR_OWNER.model) {
      st.overlay = {
        kind: 'selector',
        state: selectorExpandItems(
          st.overlay.state,
          carryModelEfforts(st.overlay.state.allItems, rebuilt()),
        ),
      }
      return true
    }
    if (st.commandWindowPreview?.kind === 'selector' && st.commandWindowPreview.trigger === 'model') {
      st.commandWindowPreview = {
        ...st.commandWindowPreview,
        state: selectorExpandItems(
          st.commandWindowPreview.state,
          carryModelEfforts(st.commandWindowPreview.state.allItems, rebuilt()),
        ),
      }
      return true
    }
    return false
  }

  /**
   * `/sessions <query>`: a normal agent turn with a prepared search task.
   * When the answer lists sessions, open the resume selector on them in the
   * agent's order so Enter resumes straight away.
   */
  async function handleSessionSearch(args: string) {
    await deps.runQuery(`/sessions ${args.trim()}`)
    const results = parseSessionSearchResults(lastAssistantText(st.appState.messages))
    if (results.length === 0) return
    const allSessions = await deps.resumeCache.all()
    const ranked = results
      .map(result => allSessions.find(s => s.session_id === result.sessionId))
      .filter((s): s is SessionMeta => s !== undefined && isInteractiveSession(s))
    if (ranked.length === 0) return
    // Each row shows the summary the search model wrote for that session.
    const summaries = new Map(results.map(result => [result.sessionId, result.summary]))
    const items = formatRankedSessionItems(ranked, id => deps.resumeCache.sessionText(id), st.sessionId, deps.sessionCloudLabel, summaries)
    invalidateExplicitResumeSelector()
    st.overlay = {
      kind: 'selector',
      // Summaries may take two lines so they can say what each session did.
      state: { ...deps.commandWindow.resumeSelectorState(items), title: 'Session search results', labelLines: 2 },
    }
    deps.renderer.requestRender()
  }

  /**
   * `cloudOnly` (from `/share`) narrows the rows structurally, by each
   * session's cloud state, never by matching the word in transcripts.
   */
  function openResumeSelector(initialQuery?: string, options: { cloudOnly?: boolean; includeAutomation?: boolean } = {}) {
    const generation = ++st.explicitResumeSelectorGeneration
    const cached = deps.resumeCache.withText ?? deps.resumeCache.metadata
    const shape = {
      showOtherCwds: Boolean(options.cloudOnly || options.includeAutomation),
      cloudFirst: Boolean(options.cloudOnly),
    }
    const rows = (sessions: SessionMeta[]) => {
      const merged = mergeRemoteSessions(sessions, deps.cloudSessions.remoteSessions)
      return options.cloudOnly
        ? merged.filter(session => deps.sessionCloudLabel(session) !== '')
        : options.includeAutomation ? merged : merged.filter(isInteractiveSession)
    }
    const items = cached === null
      ? []
      : formatSessionItems(rows(cached), deps.agent.cwd, id => deps.resumeCache.sessionText(id), st.sessionId, deps.sessionCloudLabel, shape)
    st.overlay = {
      kind: 'selector',
      state: {
        ...(options.cloudOnly ? deps.commandWindow.cloudSelectorState(items) : deps.commandWindow.resumeSelectorState(items, initialQuery)),
        ...(options.cloudOnly ? { title: 'Cloud sessions', sessionScope: 'cloud' as const } : {}),
        ...(options.includeAutomation ? { title: 'All sessions · including task runs' } : {}),
        ...(cached === null ? { emptyMessage: 'Loading sessions…' } : {}),
      },
    }
    deps.renderer.requestRender()
    if (cached !== null) deps.commandWindow.loadFocusedResumePreview(st.overlay.state)

    const activeState = (): SelectorState | null => {
      if (generation !== st.explicitResumeSelectorGeneration) return null
      if (st.overlay.kind !== 'selector' || st.overlay.state.owner !== SELECTOR_OWNER.resume) return null
      return st.overlay.state
    }

    let loadedSessions: SessionMeta[] | undefined
    const repaint = () => {
      if (!loadedSessions) return
      const current = activeState()
      if (!current || current.rename) return
      const visible = rows(loadedSessions)
      // An empty list closes with one line, whichever way it was opened.
      if (visible.length === 0) {
        invalidateExplicitResumeSelector()
        st.overlay = { kind: 'none' }
        deps.scrollback.commitSystem('sys-r', options.cloudOnly
          ? '  No shared sessions yet · /share private to sync this session, /share public to publish it'
          : '  No sessions found')
        deps.renderer.requestRender()
        return
      }
      const metaItems = formatSessionItems(visible, deps.agent.cwd, id => deps.resumeCache.sessionText(id), st.sessionId, deps.sessionCloudLabel, shape)
      st.overlay = {
        kind: 'selector',
        // Loaded: the placeholder must not survive as the no-match message.
        state: { ...selectorExpandItems(current, metaItems), emptyMessage: undefined },
      }
      deps.renderer.requestRender()
      deps.commandWindow.loadFocusedResumePreview(st.overlay.state)
    }
    st.refreshOpenSessionList = () => {
      if (!loadedSessions || !activeState()) return
      // A rename or deletion may have invalidated the local cache since this
      // selector opened. Do not resurrect its original rows on the next tick.
      void deps.resumeCache.all().then(sessions => {
        loadedSessions = sessions
        repaint()
      }).catch(() => {})
    }
    // Fetch before deciding the list is empty: this machine may have no
    // local sessions while the account already has remote ones.
    Promise.all([deps.resumeCache.all(), deps.cloudSessions.refreshIndex()]).then(([sessions]) => {
      loadedSessions = sessions
      repaint()
    }).catch((err: unknown) => {
      if (!activeState()) return
      invalidateExplicitResumeSelector()
      st.overlay = { kind: 'none' }
      deps.scrollback.commitSystem('sys-r-err', renderErrorNotice(`Failed to list sessions: ${errorText(err)}`))
      deps.renderer.requestRender()
    })
  }

  async function openShareLinks(): Promise<void> {
    invalidateExplicitResumeSelector()
    st.focusedCommandWindowGeneration = null
    deps.commandWindow.nextCommandWindowGeneration()
    deps.commandWindow.releaseCommandWindowLayout()
    const controller: ShareSelector = new ShareSelector({
      list: () => deps.agent.listShares(),
      delete: id => deps.agent.deleteShare(id),
      open: openWebLink,
      current: () => st.shareSelector === controller && st.overlay.kind === 'selector'
        && st.overlay.state.owner === SELECTOR_OWNER.shares ? st.overlay.state : undefined,
      publish: state => { st.overlay = { kind: 'selector', state }; deps.renderer.requestRender() },
    })
    st.shareSelector = controller
    await controller.load()
  }

  return { handleBackCommand, handleForkCommand, handleSessionSearch, invalidateExplicitResumeSelector, invalidateResumeSessionCache, openModelSelector, openResumeSelector, openShareLinks, refreshForkTrail, refreshOpenModelSelector, resumeSession }
}
