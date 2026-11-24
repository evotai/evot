import { basename, join } from 'node:path'
import { renderUnicodeCompact } from 'uqr'
import { getThemeScheme } from '../../ui/theme/index.js'
import { remoteHome, sharingScope } from '../../features/remote/transport.js'
import { manageGrants } from '../../features/remote/grants.js'
import { openEnvironment } from '../../features/remote/environment.js'
import { sharedConnectInvite } from '../../features/remote/cloud-connect.js'
import { isSessionIdPrefix, normalizeResumeQuery, sessionLineTitle, shortenSessionCwd } from '../../session/resume.js'
import { profileKey, registerTerminal, validTerminal, type SessionBadge } from '../../features/remote/discovery.js'
import { phoneWorkspace } from '../../features/remote/workspace.js'
import { machineName } from '../../features/remote/machine-name.js'
import type { Agent } from '../../native/index.js'
import type { PromptSuggestion } from '../app/suggestion/controller.js'
import type { CloudSessionSync } from '../../session/cloud-sessions.js'
import type { ResumeSessionCache } from '../app/session/resume-cache.js'
import { isSlashCommand } from '../../commands/index.js'
import { resolveRunInteraction } from '../app/run/run-interaction.js'
import { insertText, isEditorEmpty } from '../input/editor.js'
import { RemoteConflict, type RemoteAction, type RemoteSnapshot } from '../../features/remote/protocol.js'
import { errorText, formatElapsed, renderBar } from '../../ui/format.js'
import { renderCommandNotice } from '../../ui/command-notice.js'
import { createCommandOutput, type CommandOutputPort } from '../widgets/command-output.js'
import type { ActivityController } from './activity.js'
import { spinnerDescription } from '../widgets/spinner.js'
import { remoteModels } from '../app/remote/models.js'
import { assistantRow } from '../app/remote/conversation.js'
import { PARKED_CHECK_MS, parkedExpired, tmuxAttached } from '../app/remote/parked-exit.js'
import type { BackgroundTerminals } from '../app/background/background-terminals.js'
import type { ComposerController } from './composer.js'
import type { PendingImages } from '../app/composer/pending-images.js'
import type { RunOwnership } from '../app/run/run-ownership.js'
import type { RendererTrace } from '../diagnostics/renderer-trace.js'
import type { ModelSelectionController } from './model-selection.js'
import type { AskController } from './ask.js'
import type { RunController } from './run.js'
import type { ScrollbackController } from './scrollback.js'
import type { ReplState } from './state.js'
import type { SubmitController } from './submit.js'

export interface RemoteDeps {
  readonly readAuthIdentity: () => string | null | undefined
  readonly backgroundTerminals: BackgroundTerminals
  readonly composer: ComposerController
  readonly activity: ActivityController
  readonly agent: Agent
  readonly suggestions: Pick<PromptSuggestion, 'text' | 'completing' | 'replacing'>
  readonly gitInfo: { getBranch(): string | null }
  readonly cloudSessions: Pick<CloudSessionSync, 'remoteFor' | 'forget'>
  readonly resumeCache: Pick<ResumeSessionCache, 'remove'>
  readonly modelSelection: ModelSelectionController
  readonly asks: AskController
  readonly pendingImages: PendingImages
  readonly rendererTrace: RendererTrace
  readonly runCtl: RunController
  readonly runOwnership: RunOwnership
  readonly scrollback: ScrollbackController
  readonly submit: SubmitController
  /** One replaceable status row while /remote starts, like /share's upload row. */
  readonly replCommands: CommandOutputPort
  readonly exitAfterCleanup: (code: number) => void
}

/** `⋯ Remote  Installing cloudflared … ███░░  6.1 / 19.0 MB · 32% · 4s`, rewritten in place. */
export function remoteStatus(port: CommandOutputPort) {
  const line = createCommandOutput(port, 'remote').progress()
  const started = Date.now(), mb = (n: number) => (n / 1048576).toFixed(1)
  let text = '', bytes: { done: number; total: number } | undefined, finished = false
  const paint = () => {
    if (finished) return
    const ms = Date.now() - started
    const size = !bytes ? '' : bytes.total > 0
      ? `  ${renderBar(bytes.done, bytes.total, 20)}  ${mb(bytes.done)} / ${mb(bytes.total)} MB · ${Math.min(100, Math.floor(bytes.done / bytes.total * 100))}%`
      : ` · ${mb(bytes.done)} MB`
    line.update(renderCommandNotice({ state: 'progress', label: 'Remote', message: `${text}${size}${ms >= 1000 ? ` · ${formatElapsed(ms)}` : ''}` }))
  }
  const timer = setInterval(paint, 1000)
  timer.unref?.()
  let lastBytesPaint = 0
  return {
    get active() { return !finished },
    phase(next: string, progress?: { done: number; total: number }) {
      if (finished) return
      const now = Date.now()
      text = next; bytes = progress
      // Download chunks arrive far faster than a terminal needs them.
      if (progress && progress.done < progress.total && now - lastBytesPaint < 100) return
      lastBytesPaint = now
      paint()
    },
    finish(state: 'success' | 'error' | 'info', message: string) {
      if (finished) return
      finished = true
      clearInterval(timer)
      line.finish(renderCommandNotice({ state, label: 'Remote', message }))
    },
  }
}

/** The one command a phone may run: semantic search, never an id lookup or a picker. */
function phoneSearch(text: string) {
  const query = /^\/sessions\s+(\S[\s\S]*)$/.exec(text.trim())?.[1]?.trim()
  return !!query && !isSessionIdPrefix(normalizeResumeQuery(query))
}

export function createRemoteController(st: ReplState, deps: RemoteDeps) {
  // The visible tail moves as a run streams; its first message is not a session title.
  // Read only this session's metadata, single-flight, off the snapshot hot path.
  function sessionTitle(): string {
    const session = st.sessionId
    if (!session) { st.remoteTitle = null; return 'New conversation' }
    if (st.remoteTitle?.session !== session) {
      const meta = st.lastLineage.find(m => m.session_id === session) ?? st.preloadedSessions.find(m => m.session_id === session)
      st.remoteTitle = { session, title: meta ? sessionLineTitle(meta) : '(untitled)', refreshAfter: 0 }
    }
    const entry = st.remoteTitle
    if (Date.now() >= entry.refreshAfter) {
      entry.refreshAfter = Infinity
      void deps.agent.findSession(session).then(meta => {
        if (meta?.session_id === session) entry.title = sessionLineTitle(meta)
      }).catch(() => { /* keep the last known title if storage is busy */ })
        .finally(() => { entry.refreshAfter = Date.now() + 3000 })
    }
    return entry.title
  }
  function snapshot(backgroundView?: string): RemoteSnapshot {
    if (st.logMode || st.destroyed) throw new RemoteConflict('Session no longer shared.')
    st.remoteWatchedAt = Date.now()
    const running = st.isLoading && !!st.streamMachine
    const q = st.overlay.kind === 'ask-user' ? st.overlay.state : null
    const ask = running && st.pendingAsk && q?.requestId ? { id: q.requestId, questions: q.questions } : null
    const local =
      st.overlay.kind !== 'none' ||
      st.foregroundCommand ||
      st.loginInFlight ||
      st.queueEditState ||
      st.pendingEnqueue ||
      deps.pendingImages.awaiting ||
      st.pendingQueue.blocked ||
      st.revocationCleanup ||
      st.cloudLoginRequired
    const input = local ? null : running ? 'steer' : !st.isLoading ? 'send' : null
    const activity = deps.activity.current()
    const description =
      activity?.kind === 'spinner'
        ? spinnerDescription(activity.state, Date.now(), activity.stats, activity.options)
        : null
    const status = ask
      ? 'Waiting for your answer'
      : description?.label ??
        (activity?.kind === 'loop'
          ? `Loop · wakes in ${activity.wait.label}`
          : !input
          ? 'Busy on the computer'
          : st.conversationTail.outcome ?? 'Ready')
    const live =
      st.streamMachine &&
      assistantRow(
        st.streamMachine.pendingSwitch?.content ?? st.streamMachine.appState.currentAssistantContent,
        st.expanded,
      )
    return {
      sessionId: st.sessionId,
      title: sessionTitle(),
      // Only a next-prompt suggestion; a completion of the TUI's own half-typed draft stays local.
      suggestion: input === 'send' && !deps.suggestions.completing() && !deps.suggestions.replacing() ? deps.suggestions.text() || undefined : undefined,
      place: { name: basename(deps.agent.cwd) || '/', path: shortenSessionCwd(deps.agent.cwd), host: machineName(), branch: deps.gitInfo.getBranch() },
      generation: deps.runOwnership.owner + st.remoteEpoch,
      status,
      models: remoteModels(st.configInfo, st.appState.model, st.pendingModelHandoff),
      messageOffset: st.conversationTail.offset,
      messages: st.conversationTail.view(st.expanded),
      live: live?.text ?? '',
      liveBlocks: live?.blocks,
      active: !!activity || !!ask,
      statusDetail: description?.detail,
      expanded: st.expanded,
      background: deps.backgroundTerminals.presentation(backgroundView),
      input,
      canStop: running && (!local || !!ask),
      ask,
    }
  }

  function act(action: RemoteAction): void {
    st.remoteWatchedAt = Date.now()
    const s = snapshot()
    if (s.generation !== action.generation) throw new RemoteConflict('The run changed. Refresh and try again.')
    if (action.kind === 'tool-view') {
      if (st.expanded !== action.expanded) deps.composer.toggleExpanded()
      return
    }
    if (action.kind === 'select-model' && (s.input || s.ask)) {
      const option = s.models.options.find((o) => o.spec === action.spec)
      if (
        !option ||
        s.models.revision !== action.revision ||
        (action.effort !== undefined && !option.levels.includes(action.effort))
      ) {
        throw new RemoteConflict('Model selection changed. Pick again from the current list.')
      }
      if (!deps.modelSelection.select(action.spec, action.effort))
        throw new RemoteConflict('Model switch failed. See the computer for details.')
      return
    }
    if (action.kind === 'answer' && s.ask?.id === action.id && deps.asks.answerRequest(action.id, action.answers))
      return
    if (action.kind === 'stop' && s.canStop) {
      if (s.ask) st.overlay = { kind: 'none' }
      deps.runCtl.interruptStream('sys-remote-stop', '  Interrupted from phone.')
      return
    }
    if ((action.kind === 'send' || action.kind === 'steer') && action.kind === s.input) {
      if (isSlashCommand(action.text) && !phoneSearch(action.text))
        throw new RemoteConflict('Run slash commands in the TUI. From the phone only /sessions <request> is available.')
      if (phoneSearch(action.text) && action.kind === 'steer')
        throw new RemoteConflict('Wait for the current run to finish before searching sessions.')
      if (phoneSearch(action.text) && action.images?.length)
        throw new RemoteConflict('Session search takes text only. Remove the photos.')
      // `/sessions <request>` is an ordinary agent turn with the session-search task, the same
      // turn the TUI runs; the phone reads the answer in the chat and picks from its own list.
      deps.submit.submitConversationText(action.text, action.kind === 'steer', action.images)
      return
    }
    throw new RemoteConflict('This action is no longer available.')
  }

  function profile() {
    if (!st.configInfo) throw Error('Cannot verify the current profile.')
    const home = remoteHome(), account = deps.readAuthIdentity()
    if (account === undefined) throw Error('Cannot verify local account identity.')
    return { home, account, scope: sharingScope(home, st.configInfo.envPath || home, account ?? 'local') }
  }
  function currentScope(): string | null {
    if (st.destroyed || st.logMode || deps.rendererTrace.isEnabled) return null
    try { return profile().scope } catch { return null }
  }
  function windowStatus(): Pick<SessionBadge, 'phase' | 'runState'> {
    if ((st.pendingAsk && st.overlay.kind === 'ask-user') || st.pendingTaskModel) return { phase: 'input' }
    // Use the TUI's own run classification, without loading a transcript, spinner
    // label, task title or tool arguments for any of the windows in the list.
    const { kind } = resolveRunInteraction(deps.runCtl.runInteractionInput())
    switch (kind) {
      case 'active': return { phase: 'working' }
      case 'local-operation': return { phase: 'busy' }
      case 'idle': return { phase: st.overlay.kind !== 'none' || st.loginInFlight || st.cloudLoginRequired || st.revocationCleanup ? 'busy' : 'idle' }
      default: return { phase: 'working', runState: kind }
    }
  }
  function register() {
    if (st.terminalBus) return
    const id = process.env.EVOT_PHONE_TERMINAL,
      scope = process.env.EVOT_PHONE_SCOPE
    st.remoteChild ||= id !== undefined || scope !== undefined
    delete process.env.EVOT_PHONE_TERMINAL
    delete process.env.EVOT_PHONE_SCOPE
    try {
      st.terminalBus = registerTerminal(
        remoteHome(),
        { snapshot, act },
        () => ({
          phoneCreated: st.remoteChild,
          workspace: basename(deps.agent.cwd) || 'Terminal',
          project: profileKey(deps.agent.cwd),
          session: st.sessionId ?? '',
          title: sessionTitle(),
          ...windowStatus(),
          updatedAt: st.conversationTail.updatedAt,
        }),
        validTerminal(id) ? id : undefined,
        {
          session: () => st.sessionId ?? '',
          currentScope() {
            const current = currentScope()
            return st.remoteChild && (!validTerminal(id) || current !== scope) ? null : current
          },
        },
      )
      if (validTerminal(id) && scope && /^[0-9a-f]{24}$/.test(scope)) { st.terminalBus.share(scope); parkWhenUnwatched() }
      st.remoteEpoch = Math.floor(Math.random() * 0x100000000) * 65536
    } catch {
      /* Restricted or non-Unix hosts can still use the ordinary TUI. */
    }
  }
  // Only a window the phone launched: the user never sees it on the computer, so
  // nothing else would ever close it. The tmux probe runs only once the timeout is due.
  function parkWhenUnwatched() {
    if (st.remoteParkTimer) return
    st.remoteWatchedAt = Date.now()
    st.remoteParkTimer = setInterval(() => {
      if (st.destroyed) return
      const now = Date.now(), idle = windowStatus().phase === 'idle' && !st.pendingQueue.entries.length
      if (!idle) { st.remoteWatchedAt = now; return }
      const window = { lastWatched: st.remoteWatchedAt, idle, draft: !isEditorEmpty(st.editor), attached: false }
      if (!parkedExpired(window, now)) return
      if (tmuxAttached()) { st.remoteWatchedAt = now; return }
      deps.exitAfterCleanup(0)
    }, PARKED_CHECK_MS)
    st.remoteParkTimer.unref?.()
  }
  function close(hide = true) {
    st.remoteAttempt++
    st.remoteOpening = false
    st.remoteEpoch++
    st.remoteListener?.close()
    st.remoteListener = null
    st.terminalBus?.route(null)
    if (hide) st.terminalBus?.share(null)
    else st.terminalBus?.endInvite()
  }
  function dispose() {
    if (st.remoteParkTimer) clearInterval(st.remoteParkTimer)
    st.remoteParkTimer = null
    close()
    st.terminalBus?.close()
    st.terminalBus = null
  }
  async function command(args: string) {
    let status: ReturnType<typeof remoteStatus> | undefined
    const notice = (text: string) => deps.scrollback.commitLocalNotice('sys-remote', `  ${text}`)
    // The phone picks its session from the list, so the code carries only the computer's
    // invite: a shorter link is a smaller code. Two modules of quiet zone scan reliably.
    const showInvite = (url: string, owner: boolean) => {
      const qr = renderUnicodeCompact(url, { border: 2, invert: getThemeScheme() === 'light' })
      notice(`Remote is on for this profile, including new windows. Scan to choose a session on your phone:\n${qr}\n  ${url}\n  /remote off hides one window. /remote shutdown in the gateway TUI stops the profile. Approve new devices in ${owner ? 'this' : 'the gateway’s'} TUI.`)
    }
    if (args === 'shutdown' && !st.remoteListener && !st.remoteOpening) {
      notice('No gateway running in this window. Use /remote shutdown in the gateway TUI, or /remote off to hide this window.')
      return
    }
    if (args === 'off') {
      // The gateway can serve history and future windows even when its own
      // TUI is hidden and no other window is open yet.
      register(); st.terminalBus?.share(null)
      notice('This window is hidden. Use /remote here to show it again.')
      return
    }
    if (args === 'shutdown') {
      close(false)
      notice('Remote off. Profile gateway stopped.')
      return
    }
    if (st.remoteChild) {
      notice('Manage device access in the original TUI.')
      return
    }
    if (st.logMode) {
      notice('Leave log mode before sharing a conversation.')
      return
    }
    if (deps.rendererTrace.isEnabled) {
      notice('Disable EVOT_TUI_TRACE before managing device access.')
      return
    }
    try {
      if (args) {
        const { home, scope } = profile()
        if (args === 'devices' || args === 'revoke' || args.startsWith('revoke ')) {
          const current = () => !st.destroyed && !st.remoteChild && profile().scope === scope
          // Bare revoke is a read-only list, never an implicit choice of device.
          const message = await manageGrants(home, scope, args.split(' ').slice(1).join(' ') || undefined, current)
          if (current()) notice(message)
          return
        }
        if (!/^(approve|deny) \d{8}$/.test(args))
          throw Error('Usage: /remote [devices | revoke DEVICE | revoke all | approve CODE | deny CODE | off | shutdown]')
        const owner = st.remoteListener
        if (!owner?.active() || owner.scope !== scope) throw Error('Run this in the TUI displaying the matching approval code.')
        const [op, code] = args.split(' ')
        notice(owner.access.decide(code!, op === 'approve') ? (op === 'approve' ? 'Device approved.' : 'Device denied.') : 'No matching pending request.')
        return
      }
      register()
      if (!st.terminalBus) throw Error('Private terminal socket unavailable.')
      const { home, account, scope } = profile()
      if (st.remoteListener && st.remoteListener.scope !== scope) close()
      if (!st.remoteListener) {
        if (st.remoteOpening) {
          notice('Connecting…')
          return
        }
        const attempt = ++st.remoteAttempt,
          active = () => {
            if (st.destroyed || deps.rendererTrace.isEnabled || attempt !== st.remoteAttempt) return false
            try { return profile().scope === scope } catch { return false }
          }
        st.remoteOpening = true
        status = remoteStatus(deps.replCommands)
        try {
          status.phase('Checking for a gateway in this profile…')
          st.terminalBus.share(scope)
          const rows = await st.terminalBus.inventory()
          if (!active()) { status.finish('info', 'Cancelled.'); return }
          if (rows.gateway) {
            if (!rows.profileGateway) throw Error('An older window owns the gateway. Run /remote shutdown there, then /remote in an updated TUI to enable the whole profile.')
            if (!st.terminalBus.shared) { status.finish('info', 'This window stays hidden.'); return } // hidden while discovery was in flight
            status.finish('success', 'Joined the gateway running in another window.')
            if (account) showInvite(sharedConnectInvite(home, scope, account), false)
            else notice('Shared with the active gateway. Use /remote devices here to manage approved devices.')
            return
          }
          status.phase(account ? 'Connecting to evot Connect…' : 'Starting device approval…')
          const gateway = await openEnvironment({
            account,
            home,
            scope,
            active,
            host: { snapshot, act },
            workspace: phoneWorkspace(st.terminalBus, {
              listSessions: limit => deps.agent.listSessions(limit),
              listSessionsWithText: limit => deps.agent.listSessionsWithText(limit),
              // Mirror the picker's `d`: cloud copy, local copy, then every cached list this TUI shows.
              async deleteSession(id) {
                const remote = deps.cloudSessions.remoteFor(id)
                if (remote) { await deps.agent.cloudUnshareSession(id); deps.cloudSessions.forget(id) }
                const deleted = (await deps.agent.deleteSession(id)) || !!remote
                if (deleted) {
                  st.preloadedSessions = st.preloadedSessions.filter(s => s.session_id !== id)
                  deps.resumeCache.remove(id, st.preloadedSessions)
                }
                return deleted
              },
            }, home, deps.agent.cwd, scope, st.configInfo?.envPath),
            pending: (code, id) => {
              notice(
                `Device ${id} requests history, tool output and control for this profile, including future windows. Match ${code} on your device, then press Enter to approve, or run /remote deny ${code} (2 min).`,
              )
              // Put the approval in the composer as a draft, never submit it:
              // the user compares the code with the phone and presses Enter.
              if (isEditorEmpty(st.editor) && st.overlay.kind === 'none')
                deps.composer.mutateEditor(editor => insertText(editor, `/remote approve ${code}`))
            },
            exited: () => {
              if (attempt === st.remoteAttempt) {
                close()
                notice('Connector stopped. Run /remote to reconnect.')
              }
            },
            // While starting: the status row. Afterwards (connector restarts): plain notices.
            progress: (text, bytes) => {
              if (attempt !== st.remoteAttempt) return
              if (status?.active) status.phase(text, bytes)
              else notice(text)
            },
          })
          if (!active()) {
            gateway.close()
            status.finish('info', 'Cancelled.')
            return
          }
          st.remoteListener = gateway
          st.terminalBus.route(scope)
          if (!gateway.cloud) status.finish('success', 'Local approval gateway is on.')
          else if (gateway.online) status.finish('success', `Online at ${new URL(gateway.address).host}.`)
          else status.finish('info', `Started, but ${new URL(gateway.address).host} is not answering yet. The QR code works once Cloudflare connects.`)
        } catch (e) {
          if (attempt === st.remoteAttempt) st.terminalBus?.share(null)
          status.finish('error', errorText(e))
          throw e
        } finally {
          if (attempt === st.remoteAttempt) st.remoteOpening = false
        }
      } else st.terminalBus.share(scope)
      if (!st.terminalBus.shared) {
        notice('Profile gateway is on. This window remains hidden.')
        return
      }
      const g = st.remoteListener
      if (g.cloud) showInvite(g.url, true)
      else notice(`Approval gateway: ${g.address} · this profile, including new windows · local test only.`)
    } catch (err) {
      // The status row already shows a failure that happened while starting.
      if (!status || status.active) notice(`Remote: ${errorText(err)}`)
    }
  }
  return {
    command,
    identityChanged: () => close(),
    sessionChanged: () => {
      st.remoteEpoch++
    },
    register,
    dispose,
    snapshot,
    act,
  }
}
export type RemoteController = ReturnType<typeof createRemoteController>
