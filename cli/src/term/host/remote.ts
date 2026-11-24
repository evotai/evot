import { basename } from 'node:path'
import { hostname } from 'node:os'
import { renderUnicodeCompact } from 'uqr'
import { getThemeScheme } from '../../ui/theme/index.js'
import { remoteHome, sharingScope } from '../../features/remote/transport.js'
import { manageGrants } from '../../features/remote/grants.js'
import { openEnvironment } from '../../features/remote/environment.js'
import { sharedConnectInvite, terminalInvite } from '../../features/remote/cloud-connect.js'
import { sessionLineTitle, shortenSessionCwd } from '../../session/resume.js'
import { profileKey, registerTerminal, validTerminal, type SessionBadge } from '../../features/remote/discovery.js'
import { phoneWorkspace } from '../../features/remote/workspace.js'
import type { Agent } from '../../native/index.js'
import type { CloudSessionSync } from '../../session/cloud-sessions.js'
import type { ResumeSessionCache } from '../app/session/resume-cache.js'
import { isSlashCommand } from '../../commands/index.js'
import { resolveRunInteraction } from '../app/run/run-interaction.js'
import { insertText, isEditorEmpty } from '../input/editor.js'
import { RemoteConflict, type RemoteAction, type RemoteSnapshot } from '../../features/remote/protocol.js'
import { errorText } from '../../ui/format.js'
import type { ActivityController } from './activity.js'
import { spinnerDescription } from '../widgets/spinner.js'
import { remoteModels } from '../app/remote/models.js'
import { assistantRow } from '../app/remote/conversation.js'
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
          ? 'Busy on the Mac'
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
      place: { name: basename(deps.agent.cwd) || '/', path: shortenSessionCwd(deps.agent.cwd), host: hostname().replace(/\.local$/, ''), branch: deps.gitInfo.getBranch() },
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
        throw new RemoteConflict('Model switch failed. See the Mac for details.')
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
      if (isSlashCommand(action.text)) throw new RemoteConflict('Run slash commands on the Mac.')
      deps.submit.submitConversationText(action.text, action.kind === 'steer')
      return
    }
    throw new RemoteConflict('This action is no longer available.')
  }

  function profile() {
    if (!st.configInfo) throw Error('Cannot verify the current Mac profile.')
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
      if (validTerminal(id) && scope && /^[0-9a-f]{24}$/.test(scope)) st.terminalBus.share(scope)
      st.remoteEpoch = Math.floor(Math.random() * 0x100000000) * 65536
    } catch {
      /* Restricted or non-Unix hosts can still use the ordinary TUI. */
    }
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
    close()
    st.terminalBus?.close()
    st.terminalBus = null
  }
  async function command(args: string) {
    const notice = (text: string) => deps.scrollback.commitLocalNotice('sys-remote', `  ${text}`)
    const showInvite = (url: string, owner: boolean) => {
      url = terminalInvite(url, st.terminalBus!.id)
      const qr = renderUnicodeCompact(url, { border: 4, invert: getThemeScheme() === 'light' })
      notice(`Remote is on for this Mac profile, including new windows. Scan to choose a session on your phone:\n${qr}\n  ${url}\n  /remote off hides one window. /remote shutdown in the gateway TUI stops the profile. Approve new devices in ${owner ? 'this' : 'the gateway’s'} Mac TUI.`)
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
      notice('Manage device access in the original Mac TUI.')
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
        if (!owner?.active() || owner.scope !== scope) throw Error('Run this in the Mac TUI displaying the matching approval code.')
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
        try {
          notice('Checking for the Mac gateway…')
          st.terminalBus.share(scope)
          const rows = await st.terminalBus.inventory()
          if (!active()) return
          if (rows.gateway) {
            if (!rows.profileGateway) throw Error('An older window owns the gateway. Run /remote shutdown there, then /remote in an updated TUI to enable the whole profile.')
            if (!st.terminalBus.shared) return // hidden while discovery was in flight
            if (account) showInvite(sharedConnectInvite(home, scope, account), false)
            else notice('Shared with the active Mac gateway. Use /remote devices here to manage approved devices.')
            return
          }
          notice(account ? 'Connecting to evot Connect…' : 'Starting device approval…')
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
                `Device ${id} requests history, tool output and control for this Mac profile, including future windows. Match ${code} on your device, then press Enter to approve, or run /remote deny ${code} (2 min).`,
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
          })
          if (!active()) {
            gateway.close()
            return
          }
          st.remoteListener = gateway
          st.terminalBus.route(scope)
        } catch (e) {
          if (attempt === st.remoteAttempt) st.terminalBus?.share(null)
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
      else notice(`Mac approval gateway: ${g.address} · this profile, including new windows · local test only.`)
    } catch (err) {
      notice(`Remote: ${errorText(err)}`)
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
