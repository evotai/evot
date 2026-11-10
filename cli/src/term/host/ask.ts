import type { AskUserAnswer, AskUserParams } from '../../features/host-tools.js'
import { type TaskModelPickerRequest, type TaskModelSelection, createTaskModelWindow } from '../../features/task/model-picker.js'
import type { Agent } from '../../native/index.js'
import type { OutputLine } from '../../render/output.js'
import type { SessionHook } from '../../session/hook.js'
import { askStateToResponse, prefixedAskLines } from '../app/run/ask-user.js'
import type { ScrollbackController } from './scrollback.js'
import type { ReplState } from './state.js'
import type { TermRenderer } from '../screen/renderer.js'
import { type AskQuestion, createAskState, handleAskKeyEvent } from '../widgets/ask.js'
import type { KeyEvent } from '../../ui/keys.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface AskDeps {
  readonly agent: Agent
  readonly freezeTerminalTitle: (suffix?: string | undefined) => void
  readonly refreshConfigInfo: () => void
  readonly renderer: TermRenderer
  readonly scrollback: ScrollbackController
  readonly sessionHook: SessionHook
  readonly syncCloudNow: (force?: boolean) => Promise<void>
  readonly unfreezeTerminalTitle: () => void
}

export interface AskController {
  readonly collectAskUserAnswers: (params: AskUserParams) => Promise<AskUserAnswer[] | null>
  handleAskKey(event: KeyEvent): void
  readonly presentAskQuestions: (questions: AskQuestion[], resumeState?: "idle" | "working", transient?: boolean, owner?: symbol | undefined) => Promise<AskUserAnswer[] | null>
  readonly presentTaskModelPicker: (request: TaskModelPickerRequest) => Promise<TaskModelSelection | null>
  resolvePendingAsk(): void
  resolvePendingTaskModel(selection?: TaskModelSelection | null): void
}

/** The ask-user overlay: promise bridges for host tools, its keys, and the task-model picker. */
export function createAskController(st: ReplState, deps: AskDeps): AskController {
  function resolvePendingTaskModel(selection: TaskModelSelection | null = null) {
    if (!st.pendingTaskModel) return
    const resolve = st.pendingTaskModel
    st.pendingTaskModel = null
    deps.sessionHook.state('working')
    deps.unfreezeTerminalTitle()
    resolve(selection)
  }

  function presentTaskModelPicker(
    request: TaskModelPickerRequest,
  ): Promise<TaskModelSelection | null> {
    resolvePendingTaskModel()
    // Match /model: open immediately from the latest local config, then let a
    // cloud sync refresh the catalog in place without blocking interaction.
    deps.refreshConfigInfo()
    deps.sessionHook.state('blocked')
    st.overlay = {
      kind: 'selector',
      state: createTaskModelWindow(
        st.configInfo,
        deps.agent.model,
        request.preferredSpec,
        request.preferredThinkingLevel,
        request.note,
      ),
    }
    deps.freezeTerminalTitle('?')
    deps.renderer.requestRender()
    void deps.syncCloudNow(true)
    return new Promise(resolve => { st.pendingTaskModel = resolve })
  }

  /** Resolve any awaiting ask-user overlay as cancelled. Safe to call
   *  on every teardown path (interrupt, cancel, overlay close, re-present) so a
   *  suspended host-tool dispatch never strands the run loop. */
  function resolvePendingAsk() {
    if (st.pendingAsk) {
      st.pendingAsk(null)
      st.pendingAsk = null
    }
  }

  function presentAskQuestions(
    questions: AskQuestion[],
    resumeState: 'working' | 'idle' = 'working',
    transient = false,
    owner?: symbol,
  ): Promise<AskUserAnswer[] | null> {
    // Only one ask overlay can be active at a time; resolve any prior one as
    // cancelled before opening the next.
    resolvePendingAsk()
    deps.sessionHook.state('blocked')
    st.overlay = { kind: 'ask-user', state: { ...createAskState(questions), transient, owner } }
    deps.freezeTerminalTitle('?')
    deps.renderer.requestRender()
    return new Promise(resolve => {
      st.pendingAsk = answers => {
        deps.sessionHook.state(resumeState)
        resolve(answers)
      }
    })
  }

  const collectAskUserAnswers = (params: AskUserParams) =>
    presentAskQuestions(
      params.questions.map(q => ({
        header: q.header,
        question: q.question,
        options: q.options.map(o => ({ label: o.label, description: o.description })),
      })),
    )

  function handleAskKey(event: KeyEvent) {
    if (st.overlay.kind !== 'ask-user') return

    const extra = event.type === 'char'
      ? event.char
      : event.type === 'paste'
        ? event.text
        : event.type === 'ctrl' && (event.key === 'n' || event.key === 'p')
          ? event.key
          : undefined
    const eventType = event.type === 'ctrl' && (event.key === 'n' || event.key === 'p')
      ? `ctrl+${event.key}`
      : event.type
    const transient = st.overlay.state.transient === true
    const result = handleAskKeyEvent(st.overlay.state, eventType, extra)

    switch (result.action) {
      case 'cancel':
        // Resolve the awaiting host tool as cancelled; the tool maps this to a
        // tool error so the engine's run continues rather than hanging.
        resolvePendingAsk()
        st.overlay = { kind: 'none' }
        deps.unfreezeTerminalTitle()
        if (!transient) deps.scrollback.commitSystem('sys-ask-cancel', '  ⏺ Cancelled.')
        deps.renderer.requestRender()
        return
      case 'submit':
        {
          const response = askStateToResponse(result.state)
          if (st.pendingAsk) {
            st.pendingAsk(response)
            st.pendingAsk = null
          }
          st.overlay = { kind: 'none' }
          deps.unfreezeTerminalTitle()
          const answerLines: OutputLine[] = response.flatMap((r, i) => [
            ...prefixedAskLines(r.question, '  • ').map((text, row) => ({
              id: `sys-ask-${i}-question-${row}`,
              kind: 'system' as const,
              text,
            })),
            ...prefixedAskLines(r.answer, '    → ').map((text, row) => ({
              id: `sys-ask-${i}-answer-${row}`,
              kind: 'system' as const,
              text,
            })),
          ])
          if (!transient) deps.scrollback.commitLines(answerLines)
        }
        deps.renderer.requestRender()
        return
      case 'update':
        st.overlay = { kind: 'ask-user', state: result.state }
        deps.renderer.requestRender()
        return
    }
  }

  return { collectAskUserAnswers, handleAskKey, presentAskQuestions, presentTaskModelPicker, resolvePendingAsk, resolvePendingTaskModel }
}
