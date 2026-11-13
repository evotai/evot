import chalk from 'chalk'
import { buildHardenPrompt, resolveCommand } from '../../commands/index.js'
import { getSkillEntries } from '../../commands/skill/scan.js'
import type { ComputeSession } from '../../features/compute/session.js'
import type { LoopSession } from '../../features/loop/session.js'
import type { TaskSession } from '../../features/task/session.js'
import { isHostToolEvent } from '../../native/contracts/query-event.js'
import { type Agent, type ForkedAgent, taskShareId } from '../../native/index.js'
import type { OutputLine } from '../../render/output.js'
import type { RunThinking } from '../../render/run-thinking.js'
import { type CloudSessionSync, mergeRemoteSessions } from '../../session/cloud-sessions.js'
import { buildCommandPrompt } from '../../session/command-envelope.js'
import type { SessionHook } from '../../session/hook.js'
import { isSessionIdPrefix, normalizeResumeQuery, resolveSessionByPrefix } from '../../session/resume.js'
import type { BackgroundTerminals } from '../app/background/background-terminals.js'
import { handleSlashCommand } from '../app/composer/slash-commands.js'
import type { PrivacyFeed } from '../app/privacy-feed.js'
import type { createQueueEdit } from '../app/queue/queue-edit.js'
import { createInitialState } from '../app/run/state.js'
import { createStreamMachineState, flushStreaming, reduceRunEvent } from '../app/run/stream.js'
import type { ResumeSessionCache } from '../app/session/resume-cache.js'
import type { SuggestionContext } from '../app/suggestion/context.js'
import type { PromptSuggestion } from '../app/suggestion/index.js'
import { type ReplCommandContext, formatLogPaths, handleClipCommand, handleCopyCommand, handleEnvCommand, handleLoginCommand, handleLogoutCommand, handlePrivacyCommand, handleShareCommand, handleSkillCommand, handleUpdateCommand, handleVersionCommand, logAnalysisPrompt } from '../command-handlers.js'
import type { RendererTrace } from '../diagnostics/renderer-trace.js'
import type { ScreenLog } from '../diagnostics/screen-log.js'
import type { GitInfoProvider } from '../git-info.js'
import type { CloudController } from './cloud.js'
import type { CompactionController } from './compaction.js'
import type { FrameController } from './frame.js'
import type { RunController } from './run.js'
import type { ScrollbackController } from './scrollback.js'
import type { SessionController } from './session.js'
import type { ReplState } from './state.js'
import type { SuggestController } from './suggest.js'
import { setGhostHintContext } from '../input/editor.js'
import type { RenderDiagnostics } from '../screen/render-diagnostics.js'
import type { TermRenderer } from '../screen/renderer.js'
import { createSpinnerState, setSpinnerPhase } from '../widgets/spinner.js'
import { renderErrorNotice } from '../../ui/command-notice.js'
import { errorText } from '../../ui/format.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface SlashDeps {
  readonly agent: Agent
  readonly backgroundTerminals: BackgroundTerminals
  readonly cloudCtl: CloudController
  readonly cloudSessions: CloudSessionSync
  readonly compaction: CompactionController
  readonly compactLines: OutputLine[]
  readonly computeSession: ComputeSession
  readonly exitAfterCleanup: (code: number) => void
  readonly expandedLines: OutputLine[]
  readonly frames: FrameController
  readonly gitInfo: GitInfoProvider
  readonly loopSession: LoopSession
  readonly privacyFeed: PrivacyFeed
  readonly queueEdit: ReturnType<typeof createQueueEdit>
  readonly queueLifecycle: import('../app/queue/queue-lifecycle.js').QueueLifecycle
  readonly pendingQueue: import('../app/queue/pending-queue.js').PendingQueue
  readonly refreshConfigInfo: () => void
  readonly renderDiagnostics: RenderDiagnostics
  readonly renderer: TermRenderer
  readonly rendererTrace: RendererTrace
  readonly replCommands: ReplCommandContext
  readonly restartAfterCleanup: () => void
  readonly resumeCache: ResumeSessionCache
  readonly runCtl: RunController
  readonly runThinking: RunThinking
  readonly screenLog: ScreenLog
  readonly scrollback: ScrollbackController
  readonly sessionCtl: SessionController
  readonly sessionHook: SessionHook
  readonly suggest: SuggestController
  readonly suggestionContext: SuggestionContext
  readonly suggestions: PromptSuggestion
  readonly taskSession: TaskSession
}

export interface SlashController {
  readonly handleSlashInput: (text: string) => Promise<void>
  leaveLogMode(): void
  readonly runLogQuery: (forked: ForkedAgent, prompt: string, contentJson?: string) => Promise<void>
}

/** Slash-command dispatch and the /log side conversation. */
export function createSlashController(st: ReplState, deps: SlashDeps): SlashController {
  function leaveLogMode(): void {
    if (!st.logMode) {
      deps.scrollback.commitSystem('sys-mode', '  already in normal conversation mode')
      return
    }
    const pending = deps.queueEdit.entries()
    if (pending.length) {
      if (st.logDiscardTarget !== st.logMode) {
        st.logDiscardTarget = st.logMode
        deps.scrollback.commitSystem('sys-log-queue-discard', `  Leaving log mode discards ${pending.length} pending prompts. Run /done again to confirm; keep chatting to stay.`)
        deps.renderer.requestRender()
        return
      }
      for (const entry of pending) deps.pendingQueue.remove(entry, entry.version)
    }
    st.pendingEnqueue = null
    st.logDiscardTarget = null
    st.composerRevision++
    deps.suggestions.cancel()
    st.logMode = null
    deps.scrollback.commitSystem('sys-log-exit', '  log mode: off · normal conversation')
    deps.suggest.requestProductSuggestion('mode_changed')
  }

  async function handleSlashInput(text: string) {
    const pendingCommand = resolveCommand(text)
    if (pendingCommand.kind === 'resolved' && ['/new', '/clear', '/resume', '/fork', '/back', '/log'].includes(pendingCommand.name) && st.logMode) {
      deps.scrollback.commitSystem('sys-log-switch', '  Leave the log fork with /done before switching targets; pending log prompts require confirmation.')
      deps.renderer.requestRender()
      return
    }
    if (pendingCommand.kind === 'resolved' && ['/new', '/clear'].includes(pendingCommand.name) && !st.sessionId && deps.pendingQueue.visible(st.queueStartupTarget).length) {
      deps.scrollback.commitSystem('sys-queue-startup', '  Recover or remove the unsaved session’s pending prompts with Esc or Ctrl+G before starting a new session.')
      deps.renderer.requestRender()
      return
    }
    if (pendingCommand.kind === 'resolved' && deps.backgroundTerminals.guardSessionSwitch(pendingCommand.name)) {
      return
    }
    // `/model` used to await a cloud catalog fetch here, which froze the TUI
    // for the whole HTTP round-trip. Open on the cached list instead; a
    // background sync below refreshes the overlay when the catalog lands.
    if (pendingCommand.kind === 'resolved' && pendingCommand.name === '/model') {
      try {
        st.configInfo = deps.agent.configInfo()
      } catch (err) {
        deps.scrollback.commitSystem('sys-model-config', renderErrorNotice(`Failed to reload model config: ${errorText(err)}`))
        deps.renderer.requestRender()
        return
      }
      void deps.cloudCtl.syncCloudNow(true)
    }

    let result
    try {
      result = handleSlashCommand(text, {
        agent: deps.agent,
        appState: st.appState,
        configInfo: st.configInfo,
      })
    } catch (err) {
      deps.scrollback.commitSystem('sys-command-err', renderErrorNotice(`Command failed: ${errorText(err)}`))
      deps.renderer.requestRender()
      return
    }
    st.appState = result.appState
    if (result.overlay) st.overlay = result.overlay
    if (result.clearContext) {
      st.composerRevision++
      st.suggestionContextId++
      deps.suggestionContext.clear()
      deps.privacyFeed.forget(st.sessionId)
      deps.suggestions.cancel()
      deps.taskSession.cancelFlow()
      deps.computeSession.cancelFlow()
      deps.loopSession.reset()
      // Abort any in-flight run and clear local context view without switching sessions.
      deps.runCtl.abandonRun()
      deps.queueLifecycle.pause()
      deps.sessionHook.endSession('context_cleared')
      st.queueStartupTarget = { startup: st.queueStartupTarget.startup + 1 }
      st.sessionId = null
      st.appState = { ...createInitialState(st.appState.model, deps.agent.cwd) }
      deps.gitInfo.setCwd(deps.agent.cwd)
      deps.renderer.clearScreen()
      deps.compactLines.length = 0
      deps.expandedLines.length = 0
      deps.frames.resetHistoryCache()
      try { st.preloadedSessions = await deps.agent.listSessions(20) } catch {}
      deps.resumeCache.replace(st.preloadedSessions)
    }
    if (result.newSession) {
      st.composerRevision++
      st.suggestionContextId++
      deps.suggestionContext.clear()
      deps.privacyFeed.forget(st.sessionId)
      deps.suggestions.cancel()
      deps.taskSession.cancelFlow()
      deps.computeSession.cancelFlow()
      deps.loopSession.reset()
      deps.runCtl.abandonRun()
      deps.queueLifecycle.pause()
      // Leave the session unbound until the first real prompt. The query path
      // creates and returns the session id, so abandoning /new no longer leaves
      // an empty, untitled session in persistent storage or /resume.
      deps.sessionHook.endSession('new_session')
      st.queueStartupTarget = { startup: st.queueStartupTarget.startup + 1 }
      st.sessionId = null
      st.lastLineage = []
      setGhostHintContext({ forked: false })
      st.appState = { ...createInitialState(st.appState.model, deps.agent.cwd) }
      deps.gitInfo.setCwd(deps.agent.cwd)
      deps.renderer.clearScreen()
      deps.compactLines.length = 0
      deps.expandedLines.length = 0
      deps.frames.resetHistoryCache()
      deps.scrollback.commitSystem('sys-new-session', chalk.dim('  new session'))
    }
    if (result.exit) { deps.exitAfterCleanup(0); return }
    if (result.restart) { deps.restartAfterCleanup(); return }
    if (result.systemLines.length > 0) deps.scrollback.commitSystemLines(result.systemLines)

    // Handle async commands that the simple handleSlashCommand can't do
    const resolved = resolveCommand(text)
    if (resolved.kind !== 'resolved') {
      deps.renderer.requestRender()
      return
    }
    const { name, args } = resolved

    if (name === '/model' && args) {
      deps.refreshConfigInfo()
      // The current-model suggestion route now carries this provider's key.
      deps.suggestions.credentialsChanged()
      st.appState = { ...st.appState, model: deps.agent.model }
    }

    if (name === '/task') {
      if (args === 'cancel') {
        deps.scrollback.commitSystem('sys-task-cancel', deps.taskSession.cancelFlow()
          ? '  Task edit cancelled · nothing was saved'
          : '  No task edit in progress')
      } else if (!args || args === 'list') {
        deps.taskSession.open()
      } else if (taskShareId(args) !== null) {
        // A pasted share link is an import, not a request to interpret.
        deps.scrollback.commitUserMessage(text.trim())
        void deps.taskSession.import(args.trim())
      } else {
        deps.taskSession.create(text.trim(), args)
      }
    } else if (name === '/compute') {
      if (args === 'cancel') {
        deps.scrollback.commitSystem('sys-compute-cancel', deps.computeSession.cancelFlow()
          ? '  Compute change cancelled · nothing was saved'
          : '  No compute change in progress')
      } else if (!args || args === 'list') {
        await deps.computeSession.command(text.trim())
      } else {
        deps.computeSession.create(text.trim(), args)
      }
    } else if (name === '/loop') {
      deps.loopSession.handleCommand(text.trim(), args)
    } else if (name === '/compact') {
      await deps.compaction.runManualCompaction(args)
    } else if (name === '/env') {
      await handleEnvCommand(deps.replCommands, args)
    } else if (name === '/privacy') {
      await handlePrivacyCommand(deps.replCommands, args)
    } else if (name === '/harden') {
      deps.scrollback.commitUserMessage(text.trim())
      deps.runCtl.runQuery(buildCommandPrompt({ name: 'harden', input: text.trim(), instructions: buildHardenPrompt(args) }))
    } else if (name === '/clip') {
      const sub = args.trim().toLowerCase()
      if (sub === 'all') {
        // /clip all is expanded server-side into the memory skill's session
        // distillation prompt; bare /clip remains a zero-token local action.
        deps.scrollback.commitUserMessage(text.trim())
        deps.runCtl.runQuery('/clip all')
      } else if (sub === 'copy') {
        await handleCopyCommand(deps.replCommands)
      } else if (sub) {
        deps.scrollback.commitSystem('sys-clip-err', '  Usage: /clip [all | copy]')
      } else {
        await handleClipCommand(deps.replCommands)
      }
    } else if (name === '/share') {
      await handleShareCommand(deps.replCommands, args)
    } else if (name === '/skill') {
      try {
        await handleSkillCommand(deps.replCommands, args)
        st.skillEntries = getSkillEntries(deps.agent.skillsDirs())
      } finally {
        deps.frames.refreshBannerData()
      }
    } else if (name === '/update') {
      await handleUpdateCommand(deps.replCommands)
    } else if (name === '/version') {
      await handleVersionCommand(deps.replCommands)
    } else if (name === '/login') {
      // Device-code flow in place so free models appear without restarting.
      // Wait for an admin-sign-out cleanup before checking local identity;
      // otherwise a fast /login can race the auth-file removal.
      if (st.loginInFlight) {
        deps.scrollback.commitSystem('sys-login', '  login already in progress')
      } else {
        // Wait for an in-flight recovery first: it decides whether this login is
        // even needed, and a fast /login could otherwise race the auth cleanup.
        if (st.revocationCleanup) await st.revocationCleanup
        const { authWhoami } = await import('../../native/index.js')
        const { decideLoginGate } = await import('../../commands/login-flow.js')
        // `cloudLoginRequired` is set only after the server refused the stored
        // CLI token, so a leftover auth.json can never block a fresh flow.
        const existing = st.cloudLoginRequired ? null : await authWhoami()
        const gate = decideLoginGate(existing, st.cloudLoginRequired)
        if (gate.kind === 'already-logged-in') {
          deps.scrollback.commitSystem('sys-login', `  already logged in as ${gate.user.name} <${gate.user.email}>`)
        } else {
          st.loginInFlight = true
          try {
            const loggedIn = await handleLoginCommand(deps.replCommands)
            if (loggedIn) {
              try {
                st.cloudLoginRequired = !deps.cloudCtl.reloadAfterAuthChange()
                st.authWatcher?.sync()
                if (st.cloudLoginRequired) {
                  deps.scrollback.commitSystem('sys-login-model-err', renderErrorNotice('Login succeeded, but no cloud model was loaded. Try /login again.'))
                } else {
                  void deps.cloudCtl.syncCloudNow(true)
                }
              } catch (err) {
                st.cloudLoginRequired = true
                deps.scrollback.commitSystem('sys-login-model-err', renderErrorNotice(`Failed to load the signed-in cloud model: ${errorText(err)}`))
              }
            }
          } finally {
            st.loginInFlight = false
          }
        }
      }
    } else if (name === '/logout') {
      if (st.loginInFlight) {
        deps.scrollback.commitSystem('sys-logout', '  login in progress — wait or restart to log out')
      } else {
        if (st.revocationCleanup) await st.revocationCleanup
        const loggedOut = await handleLogoutCommand(deps.replCommands)
        if (loggedOut) {
          try {
            st.cloudLoginRequired = !deps.cloudCtl.reloadAfterAuthChange()
            st.authWatcher?.sync()
          } catch (err) {
            st.cloudLoginRequired = true
            deps.scrollback.commitSystem('sys-logout-model-err', renderErrorNotice(`Failed to reload providers after logout: ${errorText(err)}`))
          }
        }
      }
    } else if (name === '/done') {
      leaveLogMode()
    } else if (name === '/_mem') {
      deps.scrollback.commitSystem('sys-mem', `  ${deps.scrollback.memoryLine()}`)
    } else if (name === '/_dump') {
      try {
        const outcome = await deps.agent.submit(
          `/_dump${args ? ' ' + args : ''}`,
          st.sessionId ?? undefined,
          'interactive',
        )
        if (outcome.kind === 'command') {
          const lines = (outcome.message ?? '').split('\n').map((line, i) => ({
            id: `sys-dump-${i}`,
            kind: 'system' as const,
            text: `  ${line}`,
          }))
          deps.scrollback.commitLines(lines.length > 0 ? lines : [{ id: 'sys-dump', kind: 'system', text: '  (no dump output)' }])
        }
      } catch (err) {
        deps.scrollback.commitSystem('sys-dump-err', renderErrorNotice(`/_dump failed: ${errorText(err)}`))
      }
    } else if (name === '/log') {
      await handleLogCommand(args)
    } else if (name === '/fork') {
      await deps.sessionCtl.handleForkCommand(args)
    } else if (name === '/back') {
      await deps.sessionCtl.handleBackCommand(args)
    } else if (name === '/resume') {
      const query = normalizeResumeQuery(args)
      try {
        if (query === '--all') {
          deps.sessionCtl.openResumeSelector(undefined, { includeAutomation: true })
        } else if (query && isSessionIdPrefix(query)) {
          const allSessions = mergeRemoteSessions(await deps.resumeCache.all(), deps.cloudSessions.remoteSessions)
          const resolved = resolveSessionByPrefix(allSessions, query)
          if (resolved.kind === 'matched') {
            await deps.sessionCtl.resumeSession(resolved.session)
          } else {
            deps.sessionCtl.openResumeSelector(query)
          }
        } else if (query) {
          await deps.sessionCtl.handleSessionSearch(args)
        } else {
          deps.sessionCtl.openResumeSelector(undefined)
        }
      } catch (err) {
        deps.scrollback.commitSystem('sys-r-err', renderErrorNotice(`Failed to list sessions: ${errorText(err)}`))
      }
    } else if (name === '/model' && !args) {
      deps.sessionCtl.openModelSelector()
    }

    deps.renderer.requestRender()
  }

  async function handleLogCommand(args: string) {
    const query = args.trim()
    const { join } = await import('path')
    const { homedir } = await import('os')
    const logDir = join(homedir(), '.evotai', 'logs')
    const sid = st.sessionId

    if (query === 'shot' || query.startsWith('shot ')) {
      // /log shot exports the latest committed assistant turn from in-memory
      // history. This keeps renderer diagnostics off the TUI hot path.
      const unsupportedTarget = query.slice(4).trim()
      if (unsupportedTarget) {
        deps.scrollback.commitSystem('sys-log-shot-target', '  /log shot exports the latest assistant turn; message ids are no longer supported.')
        return
      }
      st.foregroundCommand = 'log-shot'
      st.isLoading = true
      st.spinnerState = setSpinnerPhase(createSpinnerState(), 'executing', 'log_shot_render')
      deps.runCtl.startSpinner()
      deps.renderer.requestRender()
      // Let the status row paint before markdown rendering starts synchronously.
      await Bun.sleep(0)
      try {
        const { writeMarkdownShot } = await import('../log-shot.js')
        const result = await writeMarkdownShot({
          historyLines: deps.compactLines,
          columns: deps.renderer.termCols,
          open: false,
          onProgress: stage => {
            const toolName = stage === 'starting_chrome'
              ? 'log_shot_chrome'
              : stage === 'capturing_png'
                ? 'log_shot_capture'
                : stage === 'opening_html'
                  ? 'log_shot_open'
                  : 'log_shot_render'
            st.spinnerState = setSpinnerPhase(st.spinnerState, 'executing', toolName)
            deps.renderer.requestRender()
          },
          header: {
            model: st.appState.model || deps.agent.model,
            thinkingLevel: st.configInfo?.thinkingLevel,
            sessionId: st.sessionId ?? undefined,
            cwd: deps.agent.cwd,
            branch: deps.gitInfo.getBranch() ?? undefined,
          },
        })
        const lines = [
          `  Shot: ${result.messageId}${result.chunkCount > 1 ? ` (${result.chunkCount} chunks)` : ''}`,
          `  HTML: ${result.htmlPath}`,
        ]
        if (result.pngPath) lines.push(`  PNG:  ${result.pngPath}`)
        else lines.push('  PNG:  (no Chrome/Chromium — HTML only. Install chromium or set EVOT_CHROME.)')
        deps.scrollback.commitSystem('sys-log-shot', lines.join('\n'))
      } catch (err) {
        deps.scrollback.commitSystem('sys-log-err', renderErrorNotice(`Shot failed: ${errorText(err)}`))
      } finally {
        st.foregroundCommand = null
        st.isLoading = false
        deps.runCtl.stopSpinner()
        deps.renderer.requestRender()
      }
    } else if (!query) {
      const logPath = deps.screenLog.filePath
      if (logPath) {
        const text = formatLogPaths(logPath, deps.rendererTrace.filePath, deps.renderDiagnostics.summary())
        deps.scrollback.commitSystem('sys-log', text ?? `  Log: ${logPath}`)
      }
      else if (sid) {
        const text = formatLogPaths(join(logDir, `${sid}.screen.log`))
        deps.scrollback.commitSystem('sys-log', text ?? `  Log: ${join(logDir, `${sid}.screen.log`)}`)
      }
      else deps.scrollback.commitSystem('sys-log', `  Log dir: ${logDir} (no active session)`)
    } else if (!sid) {
      deps.scrollback.commitSystem('sys-log-err', '  No active session to analyze.')
    } else {
      // /log <query> — fork agent to analyze log
      const logPath = join(logDir, `${sid}.screen.log`)
      const systemPrompt = logAnalysisPrompt(logPath)
      try {
        const forked = deps.agent.fork(systemPrompt)
        st.logMode = forked
        st.composerRevision++
        deps.suggestions.cancel()
        deps.scrollback.commitSystem('sys-log-mode', `  log mode: on · read-only · /done or esc to return\n  analyzing: ${logPath} · not persisted`)
        deps.renderer.requestRender()
        await runLogQuery(forked, query)
      } catch (err) {
        deps.scrollback.commitSystem('sys-log-err', renderErrorNotice(`Fork failed: ${errorText(err)}`))
      }
    }
    deps.renderer.requestRender()
  }

  async function runLogQuery(forked: import('../../native/index.js').ForkedAgent, prompt: string, contentJson?: string) {
    if (deps.cloudCtl.queryBlockedByCloudLogin()) return
    if (st.pendingQueue.blocked) {
      deps.scrollback.commitSystem('sys-queue-blocked', '  Queue ownership unresolved; Ctrl+G to reconcile before starting work.')
      return
    }
    st.logDiscardTarget = null
    const queueChain = deps.queueLifecycle.begin(forked)
    const generation = deps.runCtl.beginRun()
    st.runStartedAt = Date.now()
    st.runTurnCount = 0
    deps.runThinking.reset()
    st.liveContentMaxHeight = 0
    st.isLoading = true
    st.spinnerState = createSpinnerState()
    st.streamMachine = createStreamMachineState(st.appState, st.spinnerState)
    deps.runCtl.startSpinner()
    deps.renderer.requestRender()
    if (!st.queueDispatchId) deps.scrollback.commitUserMessage(prompt)
    let completed = false
    let terminalError = false
    let finished = false

    try {
      const stream = await forked.query(prompt, contentJson)
      if (!deps.runCtl.ownsRun(generation)) {
        stream.abort()
        return
      }
      st.streamRef = stream
      deps.queueLifecycle.started(stream)

      // Reuse the main streaming path so log-mode inherits pi-aligned behavior:
      // the whole message stays in the dynamic zone and only commits at
      // markdown-safe boundaries, so tables/lists/code blocks are never torn
      // (the old per-newline commit here split every table row into its own
      // buildAssistantLines call).
      for await (const event of stream) {
        if (st.destroyed || !deps.runCtl.ownsRun(generation)) break
        if (!st.streamMachine) break
        if (isHostToolEvent(event)) throw new Error('Readonly log run requested a host tool')

        if (event.kind === 'error') terminalError = true
        if (event.kind === 'run_finished') finished = true
        deps.runThinking.observe(event)
        const update = reduceRunEvent(st.streamMachine, event, {
          termRows: deps.renderer.termRows,
          cloudProvider: deps.cloudCtl.activeProviderIsCloud(),
        })
        st.streamMachine = update.state
        st.appState = update.state.appState
        deps.suggestionContext.observe(event)
        st.spinnerState = update.state.spinnerState
        if (update.sessionRevoked) deps.cloudCtl.handleCloudSessionRevoked()

        if (event.kind === 'assistant_delta') deps.renderer.requestRender()
        if (update.commitLines.length > 0) deps.scrollback.commitLines(update.commitLines)
        if (event.kind === 'turn_started') {
          st.runTurnCount++
          deps.queueLifecycle.reconcile()
        }
        if (update.rerenderStatus) deps.renderer.requestRender()
      }

      if (!deps.runCtl.ownsRun(generation)) return
      if (st.streamMachine) {
        const final = flushStreaming(st.streamMachine)
        st.streamMachine = final.state
        st.appState = final.state.appState
        deps.scrollback.commitFlushResult(final)
      }
      deps.queueLifecycle.reconcile()
      completed = finished && !terminalError
    } catch (err) {
      if (!deps.runCtl.ownsRun(generation)) return
      if (st.streamMachine) {
        const final = flushStreaming(st.streamMachine)
        st.streamMachine = final.state
        deps.scrollback.commitFlushResult(final)
      }
      deps.scrollback.commitSystem('sys-log-err', renderErrorNotice(`Log query failed: ${errorText(err)}`))
      deps.queueLifecycle.reconcile()
    } finally {
      if (deps.runCtl.ownsRun(generation)) {
        deps.queueLifecycle.settled(st.streamRef, queueChain, completed)
        st.streamRef = null
        st.isLoading = false
        st.streamMachine = null
        deps.runCtl.stopSpinner()
        deps.scrollback.commitRunFooter()
        deps.renderer.requestRender()
        deps.queueLifecycle.dispatchNext()
      }
    }
  }

  return { handleSlashInput, leaveLogMode, runLogQuery }
}
