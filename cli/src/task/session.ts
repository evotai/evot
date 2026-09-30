/** `/task` orchestration: list window lifecycle, key handling, and the agent
 *  turns that create or edit a task.
 *
 *  The REPL owns the terminal; this owns Task behaviour. Everything the REPL
 *  must provide is named in `TaskSessionHost`, so no Task state leaks into it.
 */

import type { ConfigInfo, ModelOption } from '../native/contracts/config-info.js'
import { selectorDown, selectorFocusOn, selectorType, selectorUp, type SelectorState } from '../term/selector.js'
import { handleSplitPaneKey, resetPaneForSelection } from '../term/split-pane.js'
import type { TranscriptItem } from '../native/index.js'
import type { KeyEvent } from '../term/input.js'
import type { AskUserAnswer, AskUserQuestion, HostToolExtension } from '../term/host-tools.js'
/** Signatures of the real RPCs. Type-only, so importing this module still
 *  loads no native addon — the calls below resolve it on first use. */
import type { createTask, deleteTask, fetchTaskShare, getTask, listTasks, runTask, shareTask, taskDeliveryDefaults, updateTask } from './client.js'
import { commitTaskChange, type TaskCommitContext } from './commit.js'
import { handleTaskKey } from './control.js'
import { createTaskExtension } from './host-tool.js'
import { ADJUST_WITH_AGENT, importArguments, importAsRequest, importExtraFields, importModelPreselect } from './import.js'
import type { TaskModelDefaults, TaskModelPickerRequest, TaskModelSelection } from './model-picker.js'
import { createTaskFlowState, createTaskPrompt, updateTaskPrompt, type TaskPromptContext } from './prompt.js'
import { createTaskWindow } from './window.js'
import { createTaskRunsWindow, createTaskTranscriptWindow } from './history.js'
import type { ScheduledTask, TaskListResponse, TaskRunSummary } from './types.js'

/** How often an open Task list re-reads cloud state. */
const REFRESH_INTERVAL_MS = 10_000

/** Narrow transport seam for deterministic deferred-response tests. */
export interface TaskSessionApi {
  list: typeof listTasks
  get: typeof getTask
  delete: typeof deleteTask
  update: typeof updateTask
  run: typeof runTask
  share: typeof shareTask
  fetchShare: typeof fetchTaskShare
  create: typeof createTask
  deliveryDefaults: typeof taskDeliveryDefaults
}

const taskApi: TaskSessionApi = {
  list: async () => (await import('./client.js')).listTasks(),
  get: async id => (await import('./client.js')).getTask(id),
  delete: async id => (await import('./client.js')).deleteTask(id),
  update: async (id, input, envFile) => (await import('./client.js')).updateTask(id, input, envFile),
  run: async id => (await import('./client.js')).runTask(id),
  share: async id => (await import('./client.js')).shareTask(id),
  fetchShare: async link => (await import('./client.js')).fetchTaskShare(link),
  create: async (input, envFile) => (await import('./client.js')).createTask(input, envFile),
  deliveryDefaults: async envFile => (await import('./client.js')).taskDeliveryDefaults(envFile),
}

export interface TaskSessionHost {
  dimensions?: () => { columns: number; rows: number }
  envFile?: string
  ensureDelivery: (signal: AbortSignal) => Promise<boolean>
  configInfo: () => ConfigInfo | undefined
  activeModelSpec: () => string
  activeModel: () => string
  modelOptionLabel: (option: ModelOption) => string
  /** True while the Task list itself is the visible overlay. */
  isTaskOverlay: () => boolean
  taskOverlayState: () => SelectorState | null
  showSelector: (state: SelectorState) => void
  currentSessionId: () => string | null
  /** Local read-only transcript for a task run; never resumes the agent. */
  loadRunTranscript: (sessionId: string) => Promise<TranscriptItem[] | null>
  closeOverlay: () => void
  requestRender: () => void
  notifyError: (text: string) => void
  /** A system line that is not an error: a published link, an import result. */
  notify: (text: string) => void
  /** Render a URL as a terminal hyperlink where supported. */
  hyperlink?: (url: string) => string
  collectAnswers: (questions: AskUserQuestion[]) => Promise<AskUserAnswer[] | null>
  presentModelPicker: (request: TaskModelPickerRequest) => Promise<TaskModelSelection | null>
  /** Show `userLine` as the user's turn, then run `prompt` with Task tools. */
  runTaskTurn: (userLine: string, prompt: string, extension: HostToolExtension) => void
  /** Put text in the editor instead of running it, for `n` → `/task `. */
  primeInput: (text: string) => void
  destroyed: () => boolean
}

export class TaskSession {
  #host: TaskSessionHost
  #response: TaskListResponse | null = null
  #api: TaskSessionApi
  #listRequest: Promise<void> | null = null
  #revision = 0
  #identityGeneration = 0
  #loadedAt = 0
  #pending = new Map<string, string>()
  #detail: ScheduledTask | undefined
  #view: 'tasks' | 'runs' | 'transcript' = 'tasks'
  #runTaskId: string | undefined
  #selectedRun: TaskRunSummary | undefined
  #transcript: TranscriptItem[] | undefined
  /** Kept when a model ends an edit with a plain-text question. The next
   * ordinary reply still has the same task tool until save/cancel. */
  #activeFlow: { flow: ReturnType<typeof createTaskFlowState>; extension: HostToolExtension; sessionId: string | null } | undefined
  #detailRequest = 0
  #loadError = false
  #disposed = false
  /** Bumped whenever the window is closed or reopened, so a slow in-flight
   *  refresh can tell that its result is no longer wanted. */
  #generation = 0
  #setup = new AbortController()
  /** Repaint callback of a mounted `/task` composer preview, if any. */
  #previewListener: (() => void) | null = null

  cancelSetup(): void { this.#setup.abort() }

  resetIdentity(): void {
    this.cancelSetup()
    this.invalidate()
    this.#identityGeneration++
    this.#revision++
    this.#response = null
    this.#detail = undefined
    this.#view = 'tasks'
    this.#runTaskId = undefined
    this.#selectedRun = undefined
    this.#transcript = undefined
    this.#activeFlow = undefined
    this.#loadedAt = 0
    this.#pending.clear()
    this.#listRequest = null
    if (this.#host.isTaskOverlay()) this.#host.closeOverlay()
  }

  constructor(host: TaskSessionHost, api: TaskSessionApi = taskApi) {
    this.#host = host
    this.#api = api
  }

  /** Scheduling belongs to the host background scheduler, not the feature. */
  refreshIfVisible(): Promise<void> {
    return this.#host.isTaskOverlay() ? this.#refresh() : Promise.resolve()
  }

  dispose(): void {
    this.#disposed = true
    this.invalidate()
    this.cancelSetup()
  }

  /** The list as the `/task` composer preview: a snapshot for this frame,
   *  with `onChange` called whenever a later load would repaint it. The
   *  caller unmounts by calling the returned function; an arrow key promotes
   *  the preview through {@link open} instead. */
  preview(onChange: () => void): { state: SelectorState; unmount: () => void } {
    this.#previewListener = onChange
    if (!this.#response || this.#response.cache.stale || Date.now() - this.#loadedAt >= REFRESH_INTERVAL_MS) {
      void this.#refresh()
    }
    return {
      state: this.previewState(),
      unmount: () => {
        if (this.#previewListener === onChange) this.#previewListener = null
      },
    }
  }

  /** Current list state shaped for the composer preview: same rows and pane,
   *  but the composer keeps the keyboard until an arrow promotes the window. */
  previewState(): SelectorState {
    // A composer preview always shows the top-level task list.
    return { ...this.#windowState(), listFocused: false }
  }

  /** `/task` with no argument, and every return to the list after an action. */
  open(focusId?: string): void {
    if (this.#disposed || this.#host.destroyed()) return
    this.#activeFlow = undefined
    this.#previewListener = null
    this.invalidate()
    this.#view = 'tasks'
    this.#runTaskId = undefined
    this.#selectedRun = undefined
    this.#transcript = undefined
    this.#loadError = false
    // Open before starting I/O. The first load has a placeholder; subsequent
    // opens render cached rows immediately, even if the server is unavailable.
    this.#paint(focusId, true)
    if (!this.#response || this.#response.cache.stale || Date.now() - this.#loadedAt >= REFRESH_INTERVAL_MS) {
      void this.#refresh()
    }
  }

  /** `/task <prompt>`: create via an agent turn. */
  create(userLine: string, request: string): void {
    const flow = createTaskFlowState('create')
    this.#startFlow(flow, userLine, createTaskPrompt(request, this.#promptContext()))
  }

  #startFlow(flow: ReturnType<typeof createTaskFlowState>, userLine: string, prompt: string): void {
    const extension = this.#extension(flow)
    this.#activeFlow = { flow, extension, sessionId: this.#host.currentSessionId() }
    this.#host.runTaskTurn(userLine, prompt, extension)
  }

  /** Bind a newly created session to the task flow; never carry an unfinished
   * edit into a different chat after /new, /resume or /fork. */
  bindFlowSession(sessionId: string, extension?: HostToolExtension): void {
    const active = this.#activeFlow
    if (active && active.extension === extension) active.sessionId = sessionId
  }

  followUpExtension(sessionId: string | null): HostToolExtension | undefined {
    const active = this.#activeFlow
    if (!active) return undefined
    if (active.flow.mutationAttempted || active.sessionId !== sessionId) {
      this.#activeFlow = undefined
      return undefined
    }
    return active.extension
  }

  /** Stop routing follow-up messages to a task tool. */
  cancelFlow(): boolean {
    const active = this.#activeFlow
    this.#activeFlow = undefined
    return Boolean(active && !active.flow.mutationAttempted)
  }

  unfinishedFlow(extension?: HostToolExtension): boolean {
    const active = this.#activeFlow
    return Boolean(active && active.extension === extension && !active.flow.mutationAttempted)
  }

  /** `/task <share-link>`: create from a shared definition, no agent turn.
   *
   *  Every field is already structured, so it goes through the same pipeline a
   *  confirmed tool call would — delivery setup, model picker, confirmation —
   *  with the shared model only positioning the picker. "Adjust with agent"
   *  hands the recipe to the normal create flow instead. */
  async import(link: string): Promise<void> {
    if (this.#disposed || this.#host.destroyed()) return
    this.#host.notify('Fetching shared task…')
    this.#host.requestRender()
    let snapshot
    try {
      snapshot = await this.#api.fetchShare(link)
    } catch (error) {
      this.#host.notifyError(`Could not import shared task: ${message(error)}`)
      return
    }
    if (this.#disposed || this.#host.destroyed()) return
    const flow = createTaskFlowState('create')
    try {
      const outcome = await commitTaskChange(this.#commitContext(flow), {
        arguments: importArguments(snapshot),
        modelPreselect: defaults => {
          const { request, note } = importModelPreselect(snapshot, defaults)
          return note ? { ...request, note } : request
        },
        extraFields: importExtraFields(snapshot, link),
        extraOptions: [{ label: ADJUST_WITH_AGENT, description: 'Change schedule, instruction or anything else with the agent before saving.' }],
      })
      if (this.#disposed || this.#host.destroyed()) return
      switch (outcome.kind) {
        case 'saved':
          this.#host.notify(outcome.message)
          this.#loadedAt = 0
          this.open(outcome.taskId)
          return
        case 'declined':
          this.create(`/task ${link}`, importAsRequest(snapshot, link))
          return
        case 'cancelled':
          this.#host.notify('Import cancelled. Nothing was created.')
          return
        case 'revise':
          // Typed feedback takes the same road as "Adjust with agent", with
          // the feedback as the first thing to do.
          this.create(`/task ${link}`, `${importAsRequest(snapshot, link)}\n\nBefore saving, change this: ${outcome.feedback}`)
          return
        case 'failed':
          this.#host.notifyError(`${outcome.message}. The save outcome is unknown; check /task before retrying.`)
          return
      }
    } catch (error) {
      this.#host.notifyError(`Could not import shared task: ${message(error)}`)
    }
  }

  /** `s` in the list: publish the focused task as an unlisted link. */
  async #share(id: string): Promise<void> {
    const task = this.#response?.tasks.find(item => item.id === id)
    if (!task || this.#pending.has(id)) return
    const generation = this.#generation
    const delivery = task.delivery_channel === 'feishu'
      ? `Delivery: Feishu · ${maskTarget(task.delivery_target)} (masked on the page)`
      : 'Delivery: local result only'
    const answers = await this.#host.collectAnswers([{
      header: 'Share task',
      question: [
        `Publish “${task.name}” as a public link?`,
        'Included: schedule, model, instruction, timeout.',
        'Excluded: owner, runs, workspace, executor.',
        delivery,
        'Anyone with the link can read the instruction as-is — check it for secrets first.',
      ].join('\n'),
      options: [
        { label: 'Publish', description: 'Create the link. Same definition, same link; edits make a new one.' },
        { label: 'Cancel', description: 'Publish nothing.' },
      ],
    }])
    if (this.#disposed || this.#host.destroyed()) return
    if (answers?.[0]?.answer !== 'Publish') {
      const typed = answers?.[0]?.answer?.trim()
      if (typed && typed !== 'Cancel') {
        this.#host.notify(`Not published. To change “${task.name}” first, use /task edit ${task.name}.`)
      }
      this.#paint(id, generation === this.#generation)
      return
    }
    this.#pending.set(id, 'Publishing…')
    this.#paint(id, generation === this.#generation)
    try {
      const created = await this.#api.share(task.id)
      if (this.#disposed || this.#host.destroyed()) return
      const link = this.#host.hyperlink?.(created.url) ?? created.url
      this.#host.notify(`Shared “${task.name}”: ${link}`)
    } catch (error) {
      if (!this.#disposed && !this.#host.destroyed()) this.#host.notifyError(`Share failed: ${message(error)}`)
    } finally {
      this.#pending.delete(id)
      this.#paint(id, generation === this.#generation)
    }
  }

  /** Called when the Task list stops being the visible overlay. */
  invalidate(): void {
    this.#generation++
    this.#detailRequest++
    // Leaving the task overlay also leaves its drill-down. A later `/task`
    // composer preview must always start at the task list, not a stale run.
    this.#view = 'tasks'
    this.#runTaskId = undefined
    this.#selectedRun = undefined
    this.#transcript = undefined
  }

  async handleKey(event: KeyEvent): Promise<void> {
    const state = this.#host.taskOverlayState()
    if (!state) return
    if (this.#view !== 'tasks') {
      await this.#handleRunKey(state, event)
      return
    }
    const size = this.#host.dimensions?.()
    const action = handleTaskKey(state, event, size?.columns, size?.rows)
    const focused = state.items[state.focusIndex]?.id
    if (state.listFocused === true && focused && this.#pending.has(focused) && event.type === 'char' && event.char === 'd') return
    switch (action.kind) {
      case 'none':
        return
      case 'update':
        this.#detailRequest++
        this.#host.showSelector(action.state)
        this.#host.requestRender()
        return
      case 'close':
        this.#close()
        this.#host.requestRender()
        return
      case 'create':
        this.#close()
        this.#host.primeInput('/task ')
        this.#host.requestRender()
        return
      case 'detail':
      case 'history':
        await this.#showDetail(action.id)
        return
      case 'share':
        await this.#share(action.id)
        return
      default:
        await this.#mutate(action.kind, action.id)
    }
  }

  async #handleRunKey(state: SelectorState, event: KeyEvent): Promise<void> {
    const size = this.#host.dimensions?.()
    const pane = handleSplitPaneKey(state, event, size?.columns, size?.rows)
    if (pane) {
      if (pane.kind === 'update') this.#host.showSelector(pane.state)
      this.#host.requestRender()
      return
    }
    if (event.type === 'escape') {
      this.#detailRequest++
      if (this.#view === 'transcript') {
        this.#view = 'runs'
        this.#transcript = undefined
        this.#paint(this.#selectedRun?.id)
      } else {
        this.#view = 'tasks'
        this.#paint(this.#runTaskId)
        this.#runTaskId = undefined
      }
      return
    }
    if (event.type === 'up' || (event.type === 'char' && event.char === 'k')
        || event.type === 'down' || (event.type === 'char' && event.char === 'j')) {
      const up = event.type === 'up' || (event.type === 'char' && event.char === 'k')
      const next = up ? selectorUp(state) : selectorDown(state)
      this.#host.showSelector(resetPaneForSelection(state, next))
      this.#host.requestRender()
      return
    }
    if (event.type !== 'enter' || this.#view !== 'runs') return
    const id = state.items[state.focusIndex]?.id
    const task = this.#detail
    const run = task?.runs?.find(row => row.id === id)
      ?? task?.recent_runs?.find(row => row.id === id)
      ?? this.#response?.tasks.find(row => row.id === this.#runTaskId)?.recent_runs?.find(row => row.id === id)
    if (!run?.session_id || !task) return
    const generation = this.#generation
    const request = ++this.#detailRequest
    try {
      const transcript = await this.#host.loadRunTranscript(run.session_id)
      if (this.#disposed || this.#host.destroyed() || generation !== this.#generation
          || request !== this.#detailRequest || this.#view !== 'runs'
          || !this.#host.isTaskOverlay()) return
      if (!transcript) {
        this.#host.notify('Execution transcript is not on this device; run status and errors are still available here.')
        return
      }
      this.#selectedRun = run
      this.#transcript = transcript
      this.#view = 'transcript'
      this.#paint()
    } catch (error) {
      if (generation === this.#generation && request === this.#detailRequest && this.#host.isTaskOverlay()) {
        this.#host.notifyError(`Could not load execution transcript: ${message(error)}`)
      }
    }
  }

  /** Keep the focused run/entry and its detail scroll during a background
   * refresh. Changing levels deliberately starts at the first row. */
  #keepBrowsePosition(state: SelectorState, current: SelectorState | null, focus?: string): SelectorState {
    const index = state.items.findIndex(row => row.id === focus)
    if (index >= 0) state.focusIndex = index
    if (!current || current.title !== state.title) return state
    state.scrollOffset = current.scrollOffset
    if (index >= 0 && current.previewPane) state.previewPane = { ...current.previewPane }
    return state
  }

  async #showDetail(id: string): Promise<void> {
    if (this.#pending.has(id)) return
    const generation = this.#generation
    const revision = this.#revision
    const request = ++this.#detailRequest
    const current = () => !this.#disposed && !this.#host.destroyed()
      && this.#host.isTaskOverlay() && generation === this.#generation
      && request === this.#detailRequest && revision === this.#revision
    try {
      const task = await this.#api.get(id)
      if (!current()) return
      this.#detail = task
      this.#runTaskId = id
      this.#view = 'runs'
      this.#paint()
    } catch (error) {
      if (current()) this.#host.notifyError(`Failed to load task: ${message(error)}`)
    }
  }

  async #mutate(kind: 'edit' | 'toggle' | 'run' | 'delete', id: string): Promise<void> {
    const task = this.#response?.tasks.find(item => item.id === id)
    if (!task || this.#pending.has(id)) return
    if (kind === 'edit') {
      this.#close()
      const flow = createTaskFlowState('update', task)
      this.#startFlow(flow, `/task edit ${task.name}`, updateTaskPrompt(task, this.#promptContext(task)))
      return
    }
    const generation = this.#generation
    const identity = this.#identityGeneration
    let queued = false
    this.#pending.set(id, kind === 'delete' ? 'Deleting…' : kind === 'toggle' ? 'Updating…' : 'Starting…')
    // Invalidate any list snapshot or detail started before this mutation.
    this.#revision++
    this.#detailRequest++
    this.#paint()
    let nextFocus: string | undefined
    try {
      if (kind === 'toggle') {
        const updated = await this.#api.update(task.id, { revision: task.revision, enabled: !task.enabled }, this.#host.envFile)
        if (identity !== this.#identityGeneration) return
        if (this.#response) this.#response = {
          ...this.#response, tasks: this.#response.tasks.map(row => row.id === id ? updated.task : row),
        }
      } else if (kind === 'run') {
        if (!(await this.#confirmRun(task))) return
        if (this.#disposed || this.#host.destroyed() || generation !== this.#generation) return
        await this.#api.run(task.id)
        // A run lives only on the server; refetch so the row turns Queued
        // instead of sitting on the stale last run until the next poll.
        this.#loadedAt = 0
        queued = true
      } else {
        await this.#api.delete(task.id)
        if (identity !== this.#identityGeneration) return
        if (this.#response) {
          const rows = this.#response.tasks
          const at = rows.findIndex(row => row.id === id)
          const state = this.#host.taskOverlayState()
          if (state?.items[state.focusIndex]?.id === id) nextFocus = rows[at + 1]?.id ?? rows[at - 1]?.id
          this.#response = { ...this.#response, tasks: rows.filter(row => row.id !== id) }
        }
      }
      if (this.#detail?.id === id) this.#detail = undefined
    } catch (error) {
      this.#loadedAt = 0
      const text = message(error)
      if (identity === this.#identityGeneration && !this.#disposed && !this.#host.destroyed()) {
        // The server allows one active run per task; pressing run while it is
        // queued or in flight is not a failure, it is just already committed.
        this.#host.notifyError(
          kind === 'run' && /busy|active run/i.test(text)
            ? `“${task.name}” already has a run in flight — wait for it to finish.`
            : `Task operation failed: ${text}. Check task status before retrying.`,
        )
      }
    } finally {
      if (identity !== this.#identityGeneration) return
      this.#revision++
      this.#pending.delete(id)
      if (queued) void this.#refresh()
      // Update any currently visible list from cache, but only the original
      // run confirmation may restore its temporarily hidden window. That
      // confirm overlay replaces the list, so the selector can no longer
      // report the selection — restore the acted-on row by id.
      this.#paint(kind === 'run' ? id : nextFocus, kind === 'run' && generation === this.#generation)
    }
  }

  async #confirmRun(task: ScheduledTask): Promise<boolean> {
    const destination = task.delivery_channel
      ? `\nResult: ${task.delivery_channel} · ${task.delivery_target}`
      : ''
    const answers = await this.#host.collectAnswers([{
      header: 'Run task',
      question: `Run “${task.name}” now?${destination}`,
      options: [
        { label: 'Run now', description: 'Start one manual run with the saved configuration.' },
        { label: 'Cancel', description: 'Return without starting a run.' },
      ],
    }])
    const answer = answers?.[0]?.answer
    if (answer === 'Run now') return true
    const typed = answer?.trim()
    if (typed && typed !== 'Cancel') {
      this.#host.notify(`Not run. To change “${task.name}” first, use /task edit ${task.name}.`)
    }
    return false
  }

  /** One list request at a time. Mutations fence older snapshots so a late
   * pre-delete response cannot resurrect a removed row. No persistent cache. */
  #refresh(): Promise<void> {
    if (this.#listRequest) return this.#listRequest
    if (this.#pending.size || this.#disposed) return Promise.resolve()
    const revision = this.#revision
    this.#loadError = false
    const request = Promise.resolve().then(async () => {
      try {
        const response = await this.#api.list()
        if (this.#disposed || this.#host.destroyed() || revision !== this.#revision) return
        this.#response = response
        this.#loadedAt = Date.now()
        if (this.#runTaskId && !response.tasks.some(row => row.id === this.#runTaskId)) {
          this.#view = 'tasks'
          this.#runTaskId = undefined
          this.#selectedRun = undefined
          this.#transcript = undefined
          this.#detail = undefined
        } else if (this.#view === 'tasks') this.#detail = undefined
      } catch {
        if (this.#disposed || this.#host.destroyed() || revision !== this.#revision) return
        // List loads are retried by the background scheduler. Keep failures
        // in the task window, not as permanent lines in the chat transcript.
        this.#loadError = true
      } finally {
        if (this.#listRequest === request) {
          this.#listRequest = null
          this.#paint()
        }
      }
    })
    this.#listRequest = request
    this.#paint()
    return request
  }

  #paint(focusId?: string, open = false): void {
    if (this.#disposed || this.#host.destroyed()) return
    if (!open && !this.#host.isTaskOverlay()) {
      // Not our overlay, but a composer preview may be showing the list.
      this.#previewListener?.()
      return
    }
    const state = this.#windowState(focusId)
    const focusedId = state.items[state.focusIndex]?.id
    this.#host.showSelector(focusedId ? selectorFocusOn(state, row => row.id === focusedId) : state)
    this.#host.requestRender()
  }

  /** The list window from cached rows plus in-flight status, carrying over
   *  scroll, pane and an armed delete from the overlay it replaces. */
  #windowState(focusId?: string): SelectorState {
    const current = this.#host.taskOverlayState()
    const focus = focusId ?? (current ? current.items[current.focusIndex]?.id : undefined)
    const response = this.#response ?? { tasks: [], cache: { ready: false, synced_at: 0, stale: false } }
    const task = response.tasks.find(row => row.id === this.#runTaskId)
    if (this.#view === 'transcript' && task && this.#selectedRun && this.#transcript) {
      const state = createTaskTranscriptWindow(task, this.#selectedRun, this.#transcript)
      return this.#keepBrowsePosition(state, current, focus)
    }
    if (this.#view === 'runs' && task) {
      const runs = this.#detail?.id === task.id && this.#detail.revision === task.revision
        ? this.#detail.runs ?? task.recent_runs ?? [] : task.recent_runs ?? []
      const state = createTaskRunsWindow(task, runs)
      return this.#keepBrowsePosition(state, current, focus)
    }
    let state = createTaskWindow(response, focus, this.#detail, this.#modelLabels())
    if (current?.presentation === 'browser') {
      state = { ...state, listFocused: current.listFocused }
      if (current.query) state = selectorType(state, current.query)
      if (focus) state = selectorFocusOn(state, row => row.id === focus)
    }
    // Before the first response the empty body carries the whole message;
    // the subtitle only speaks once there is a list to annotate.
    if (!this.#response) {
      // Empty, not absent: the header keeps its Task styling instead of
      // falling back to the generic `0` tally.
      state.subtitle = ''
      state.emptyMessage = this.#loadError ? 'Could not load tasks · reopen /task to retry' : 'Loading tasks…'
    } else if (this.#pending.size) state.subtitle = [...this.#pending.values()].join(' · ')
    else if (this.#listRequest) state.subtitle = 'Refreshing…'
    else if (this.#loadError) state.subtitle = 'Could not refresh · reopen /task to retry'
    // Refreshing should not disarm a deliberate first `d` or reset scrolling.
    if (current) {
      state.scrollOffset = current.scrollOffset
      if (current.items[current.focusIndex]?.id === focus && current.previewPane) {
        state.previewPane = { ...current.previewPane }
      }
      const armed = current.pendingDeleteId
      if (armed && !this.#pending.has(armed) && state.items.some(row => row.id === armed)) {
        state.pendingDeleteId = armed
        state.subtitle = current.subtitle
      }
    }
    for (const row of state.allItems) {
      if (row.id && this.#pending.has(row.id)) {
        row.detail = this.#pending.get(row.id)
        row.pendingAction = true
      }
    }
    return state
  }

  #close(): void {
    this.invalidate()
    this.#view = 'tasks'
    this.#runTaskId = undefined
    this.#transcript = undefined
    this.#host.closeOverlay()
  }

  #extension(flow: ReturnType<typeof createTaskFlowState>): HostToolExtension {
    return createTaskExtension(this.#commitContext(flow))
  }

  /** Everything a Task mutation needs from the host, bound to a fresh setup
   *  abort so a cancelled flow cannot leave a Feishu onboarding waiting. */
  #commitContext(flow: ReturnType<typeof createTaskFlowState>): TaskCommitContext {
    this.#loadedAt = 0
    this.#revision++
    this.cancelSetup()
    this.#setup = new AbortController()
    const signal = this.#setup.signal
    return {
      flow,
      ensureDelivery: () => this.#host.ensureDelivery(signal),
      defaults: () => this.#modelDefaults(),
      pickModel: request => this.#host.presentModelPicker(request),
      collectAnswers: params => this.#host.collectAnswers(params.questions),
      persist: { create: this.#api.create, update: this.#api.update },
    }
  }

  /** Model catalog plus device delivery target, read when a Task tool actually
   *  fires rather than on every streamed event. */
  async #modelDefaults(): Promise<TaskModelDefaults> {
    const config = this.#host.configInfo()
    const activeSpec = this.#host.activeModelSpec()
    const delivery = await this.#api.deliveryDefaults(this.#host.envFile)
    return {
      model_spec: activeSpec,
      thinking_level: config?.thinkingLevel ?? '',
      available_models: (config?.availableModels ?? []).map(model => ({
        spec: model.spec,
        model: model.model,
        label: this.#host.modelOptionLabel(model),
        group: model.group_label ?? model.provider,
        thinking_level: model.spec === activeSpec
          ? config?.thinkingLevel ?? model.thinking_level ?? ''
          : model.thinking_level ?? '',
      })),
      feishu_ready: delivery.feishu_ready,
      feishu_target: delivery.feishu_target,
      env_file: this.#host.envFile,
    }
  }

  #modelLabels(): Record<string, string> {
    return Object.fromEntries(
      (this.#host.configInfo()?.availableModels ?? [])
        .map(option => [option.spec, this.#host.modelOptionLabel(option)]),
    )
  }

  #promptContext(task?: ScheduledTask): TaskPromptContext {
    const config = this.#host.configInfo()
    const activeSpec = this.#host.activeModelSpec()
    const active = config?.availableModels.find(model => model.spec === activeSpec)
    const saved = task?.model_policy === 'fixed'
      ? config?.availableModels.find(model => model.spec === task.model_spec)
      : undefined
    return {
      localTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      currentModel: active ? this.#host.modelOptionLabel(active) : this.#host.activeModel(),
      thinkingLevel: config?.thinkingLevel ?? '',
      availableModels: (config?.availableModels ?? []).map(this.#host.modelOptionLabel),
      savedModel: saved
        ? this.#host.modelOptionLabel(saved)
        : task?.model_spec
          ? task.model_spec.slice(task.model_spec.indexOf(':') + 1)
          : undefined,
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Mirror of the server's masking, for the publish confirmation only: the
 *  page itself is masked by the server from the stored task. */
export function maskTarget(target: string): string {
  if (target === 'p2p:*') return 'all bot direct conversations'
  const separator = target.indexOf('_')
  if (separator < 0 || separator === target.length - 1) return '••••'
  return `${target.slice(0, separator + 5)}••••`
}
