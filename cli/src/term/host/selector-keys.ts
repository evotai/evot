import type { ComputeSession } from '../../features/compute/session.js'
import { formatModelLabel, formatModelOptionLabel, selectModelOption } from '../../features/models/options.js'
import type { TaskSession } from '../../features/task/session.js'
import { TASK_RUNTIME_DEFAULT_MODEL } from '../../features/task/types.js'
import type { Agent, SessionMeta } from '../../native/index.js'
import type { CloudSessionSync } from '../../session/cloud-sessions.js'
import { modelShareEvents } from '../../session/share-events.js'
import type { createQueueEdit } from '../app/queue/queue-edit.js'
import { handleSelectorControl } from '../app/selector/selector-control.js'
import type { ResumeSessionCache } from '../app/session/resume-cache.js'
import { saveSessionRename } from '../app/session/session-rename.js'
import type { AskController } from './ask.js'
import type { CloudController } from './cloud.js'
import type { CommandWindowController } from './command-window.js'
import type { ComposerController } from './composer.js'
import type { ScrollbackController } from './scrollback.js'
import type { SessionController } from './session.js'
import type { ReplState } from './state.js'
import type { TermRenderer } from '../screen/renderer.js'
import { renderErrorNotice } from '../../ui/command-notice.js'
import { errorText } from '../../ui/format.js'
import type { KeyEvent } from '../../ui/keys.js'
import { SELECTOR_OWNER } from '../../ui/selector-identity.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface SelectorKeysDeps {
  readonly agent: Agent
  readonly asks: AskController
  readonly cloudCtl: CloudController
  readonly cloudSessions: CloudSessionSync
  readonly commandWindow: CommandWindowController
  readonly composer: ComposerController
  readonly computeSession: ComputeSession
  readonly queueEdit: ReturnType<typeof createQueueEdit>
  readonly queueLifecycle: import('../app/queue/queue-lifecycle.js').QueueLifecycle
  readonly refreshConfigInfo: () => void
  readonly renderer: TermRenderer
  readonly resumeCache: ResumeSessionCache
  readonly scrollback: ScrollbackController
  readonly sessionCtl: SessionController
  readonly taskSession: TaskSession
}

export interface SelectorKeysController {
  handleSelectorKey(event: KeyEvent): void
}

/** Key handling while a selector overlay owns the keyboard. */
export function createSelectorKeysController(st: ReplState, deps: SelectorKeysDeps): SelectorKeysController {
  function handleSelectorKey(event: KeyEvent) {
    if (st.overlay.kind !== 'selector') return
    if (st.overlay.state.owner === SELECTOR_OWNER.task) {
      void deps.taskSession.handleKey(event)
      return
    }
    if (st.overlay.state.owner === SELECTOR_OWNER.compute) {
      void deps.computeSession.handleKey(event)
      return
    }
    const action = handleSelectorControl(st.overlay.state, event, deps.renderer.termCols, deps.renderer.termRows,
      st.focusedCommandWindowGeneration !== null ? st.selectorPreviewViewport : undefined)

    switch (action.kind) {
      case 'update':
        st.overlay = { kind: 'selector', state: action.state }
        deps.renderer.requestRender()
        if (action.state.owner === SELECTOR_OWNER.resume && !action.state.rename) {
          if (st.focusedCommandWindowGeneration !== null) {
            deps.commandWindow.scheduleFocusedResumeEnrichment(
              st.focusedCommandWindowGeneration,
              action.state.query.length > 0,
            )
          }
          deps.commandWindow.loadFocusedResumePreview(action.state)
        }
        return
      case 'close':
        deps.sessionCtl.invalidateExplicitResumeSelector()
        st.overlay = { kind: 'none' }
        st.focusedCommandWindowGeneration = null
        deps.commandWindow.cancelResumeSearchEnrichment()
        deps.commandWindow.nextCommandWindowGeneration()
        deps.commandWindow.releaseCommandWindowLayout()
        deps.renderer.requestRender()
        return
      case 'resume':
        deps.sessionCtl.invalidateExplicitResumeSelector()
        st.overlay = { kind: 'none' }
        st.focusedCommandWindowGeneration = null
        deps.commandWindow.nextCommandWindowGeneration()
        deps.composer.clearAll()
        deps.commandWindow.releaseCommandWindowLayout()
        deps.sessionCtl.resumeSession({ session_id: action.sessionId } as SessionMeta).then(() => deps.renderer.requestRender())
        deps.renderer.requestRender()
        return
      case 'select-task-model': {
        const selected = action.spec === TASK_RUNTIME_DEFAULT_MODEL
          ? undefined
          : selectModelOption(st.configInfo, action.spec)
        st.overlay = { kind: 'none' }
        deps.asks.resolvePendingTaskModel({
          spec: action.spec,
          ...(action.thinkingLevel !== undefined ? { thinkingLevel: action.thinkingLevel } : {}),
          ...(selected ? {
            model: selected.model,
            label: formatModelOptionLabel(selected),
            group: selected.group_label ?? selected.provider,
            defaultThinkingLevel: selected.thinking_level ?? '',
          } : {}),
        })
        deps.renderer.requestRender()
        return
      }
      case 'pin-default-model':
        void deps.cloudCtl.pinDefaultModel(action.spec)
        return
      case 'select-model': {
        st.overlay = { kind: 'none' }
        st.focusedCommandWindowGeneration = null
        deps.commandWindow.nextCommandWindowGeneration()
        deps.composer.clearAll()
        deps.commandWindow.releaseCommandWindowLayout()
        try {
          deps.agent.setProvider(action.spec)
          deps.refreshConfigInfo()
          // The picker commits a model and its effort as one gesture. The tier
          // is applied after the switch, since it is the new model's ladder
          // that decides whether the tier exists at all; a rejected tier leaves
          // the model's own resolved level in place rather than failing the
          // switch the user actually asked for.
          let effort = st.configInfo?.thinkingLevel ?? ''
          if (action.thinkingLevel !== undefined && action.thinkingLevel !== effort) {
            const applied = deps.agent.setThinkingLevel(action.thinkingLevel)
            if (applied !== null) {
              deps.refreshConfigInfo()
              effort = applied
            }
          }
          const selected = selectModelOption(st.configInfo, action.spec)
          const model = selected?.model ?? deps.agent.model
          const provider = selected?.provider ?? st.configInfo?.provider ?? ''
          st.appState = { ...st.appState, model }
          const label = formatModelLabel(model, provider, selected?.group_label)
          // Effort shares the model's status slot: they were chosen together, so
          // reporting them apart would read as two unrelated switches.
          deps.scrollback.commitStatusLine({
            id: 'sys-model',
            kind: 'system',
            text: `  Model → ${label}${effort ? ` · thinking ${effort}` : ''}`,
            shareEvents: modelShareEvents(provider, model, effort),
          })
        } catch (err) {
          deps.scrollback.commitSystem('sys-model-err', renderErrorNotice(`Failed to switch model: ${errorText(err)}`))
        }
        deps.renderer.requestRender()
        return
      }
      case 'rename-session': {
        st.overlay = { kind: 'selector', state: action.state }
        deps.commandWindow.cancelResumeSearchEnrichment()
        const token = action.state.rename
        if (token) void saveSessionRename({
          renameSession: (id, title) => deps.agent.renameSession(id, title),
          current: () => st.overlay.kind === 'selector' && st.overlay.state.owner === SELECTOR_OWNER.resume ? st.overlay.state : undefined,
          publish: state => { st.overlay = { kind: 'selector', state }; deps.renderer.requestRender() },
          cache: deps.resumeCache,
          cwd: deps.agent.cwd,
        }, token, action.title)
        deps.renderer.requestRender()
        return
      }
      case 'delete-session':
        st.overlay = { kind: 'selector', state: action.state }
        // A cloud row goes from both places; a remote-only row has no local copy
        // to delete, so removing the cloud copy is the whole deletion.
        void (async () => {
          const remote = deps.cloudSessions.remoteFor(action.sessionId)
          if (remote) {
            await deps.agent.cloudUnshareSession(action.sessionId)
            deps.cloudSessions.forget(action.sessionId)
          }
          return (await deps.agent.deleteSession(action.sessionId)) || Boolean(remote)
        })().then(ok => {
          if (ok) {
            st.preloadedSessions = st.preloadedSessions.filter(session => session.session_id !== action.sessionId)
            deps.resumeCache.remove(action.sessionId, st.preloadedSessions)
            deps.scrollback.commitSystem('sys-del', `  Deleted session ${action.label}`)
            // Also surface it on the overlay: resuming another session clears
            // the screen, which would otherwise wipe the only confirmation.
            if (st.overlay.kind === 'selector' && st.overlay.state.owner === SELECTOR_OWNER.resume) {
              st.overlay = {
                kind: 'selector',
                state: { ...st.overlay.state, subtitle: `Deleted ${action.label}` },
              }
              deps.renderer.requestRender()
            }
          }
        })
        deps.renderer.requestRender()
        return
      case 'unshare-session':
        st.overlay = { kind: 'selector', state: action.state }
        // The cloud copy goes and the local session stays. A row this machine
        // has no copy of would lose its only copy, which is `d`'s job to say.
        void (async () => {
          const local = (await deps.resumeCache.all()).some(session => session.session_id === action.sessionId)
          if (!local) throw new Error('this machine has no copy of it · enter resumes it here first, d deletes it from the cloud')
          await deps.agent.cloudUnshareSession(action.sessionId)
          deps.cloudSessions.forget(action.sessionId)
          deps.resumeCache.update(action.sessionId, { cloud: null })
          if (action.sessionId === st.sessionId) await deps.sessionCtl.refreshForkTrail(action.sessionId)
          return `Removed ${action.label} from cloud · local copy kept`
        })().then(text => {
          deps.scrollback.commitSystem('sys-share', `  ${text}`)
          // The cloud list already dropped the row; the sessions list keeps it
          // and needs its access column redrawn.
          return { subtitle: text, repaint: action.state.sessionScope !== 'cloud' }
        }, (error: unknown) => {
          const text = `Unshare failed: ${errorText(error)}`
          deps.scrollback.commitSystem('sys-share-error', renderErrorNotice(text))
          // The row left the cloud list on the confirming keypress; bring it back.
          return { subtitle: text, repaint: true }
        }).then(({ subtitle, repaint }) => {
          // Also surface it on the overlay, as delete does: resuming another
          // session clears the screen and would wipe the only confirmation.
          if (st.overlay.kind === 'selector' && st.overlay.state.owner === SELECTOR_OWNER.resume) {
            st.overlay = { kind: 'selector', state: { ...st.overlay.state, subtitle } }
          }
          if (repaint) st.refreshOpenSessionList?.()
          deps.renderer.requestRender()
        })
        deps.renderer.requestRender()
        return
      case 'open-share':
        void st.shareSelector?.open(action.shareId)
        return
      case 'delete-share':
        st.overlay = { kind: 'selector', state: action.state }
        void st.shareSelector?.delete(action.shareId)
        deps.renderer.requestRender()
        return
      case 'queue-resume':
        st.overlay = { kind: 'none' }
        deps.queueLifecycle.resumePaused()
        return
      case 'queue-edit':
        deps.queueEdit.editQueuedPrompt(action.entry)
        return
      case 'queue-remove':
        deps.queueEdit.removeQueuedPrompt(action.entry)
        return
      case 'none':
        return
    }
  }

  return { handleSelectorKey }
}
