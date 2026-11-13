import { getSkillEntries } from '../../commands/skill/index.js'
import type { ComputeSession } from '../../features/compute/session.js'
import type { TaskSession } from '../../features/task/session.js'
import type { Agent, SessionMeta } from '../../native/index.js'
import { type CloudSessionSync, mergeRemoteSessions } from '../../session/cloud-sessions.js'
import { applySessionText, formatSessionItems } from '../../session/resume.js'
import type { createQueueEdit } from '../app/queue/queue-edit.js'
import { isCommandWindowBridge, resolveCommandWindowTrigger } from '../app/selector/command-window-trigger.js'
import { handleSelectorControl } from '../app/selector/selector-control.js'
import { createModelWindow, createResumeWindow } from '../app/selector/selector-windows.js'
import { createSkillSelectorState } from '../app/selector/skill-window.js'
import type { ResumeSessionCache } from '../app/session/resume-cache.js'
import type { ResumeItemCache } from '../app/session/resume-items.js'
import type { ReplState } from './state.js'
import { getEditorText } from '../input/editor.js'
import type { TermRenderer } from '../screen/renderer.js'
import { errorText } from '../../ui/format.js'
import type { KeyEvent } from '../../ui/keys.js'
import { SELECTOR_OWNER } from '../../ui/selector-identity.js'
import { type SelectorItem, type SelectorState, selectorExpandItems, selectorReplaceItem, warmSearchableText } from '../../ui/selector.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface CommandWindowDeps {
  readonly agent: Agent
  readonly clearAll: () => void
  readonly cloudSessions: CloudSessionSync
  readonly computeSession: ComputeSession
  readonly flushDeferredCloudUpdates: () => void
  readonly queueEdit: ReturnType<typeof createQueueEdit>
  readonly renderer: TermRenderer
  readonly resumeCache: ResumeSessionCache
  readonly resumeItems: ResumeItemCache
  readonly sessionCloudLabel: (session: SessionMeta) => string
  readonly taskSession: TaskSession
}

export interface CommandWindowController {
  activateCommandWindow(event: KeyEvent): boolean
  cancelCommandWindowLoads(): void
  cancelResumeSearchEnrichment(): void
  cancelSearchTextWarm(): void
  cloudSelectorState(items: SelectorItem[]): SelectorState
  commandWindowMounted(): boolean
  loadFocusedResumePreview(state: SelectorState): void
  nextCommandWindowGeneration(): number
  refreshCommandWindowPreview(allowMount: boolean): void
  releaseCommandWindowLayout(): void
  resumeSelectorState(items: SelectorItem[], initialQuery?: string | undefined): SelectorState
  scheduleFocusedResumeEnrichment(generation: number, includeText?: boolean): void
}

/** Live command-window previews (model, resume, skill, task, compute, share) driven by the composer text. */
export function createCommandWindowController(st: ReplState, deps: CommandWindowDeps): CommandWindowController {
  function nextCommandWindowGeneration(): number {
    st.commandWindowPreviewGeneration++
    return st.commandWindowPreviewGeneration
  }

  function commandWindowMounted(): boolean {
    return st.commandWindowPreview !== null || st.focusedCommandWindowGeneration !== null
  }

  function releaseCommandWindowLayout(): void {
    st.commandWindowContentLines = null
    st.commandWindowContentWidth = null
    st.selectorPreviewViewport = undefined
    // The window is gone, so its search-text warm-up has nothing left to serve.
    // Cancelling here rather than per keystroke keeps warming alive across
    // typing inside an open window, which is exactly when it is needed.
    cancelSearchTextWarm()
    deps.flushDeferredCloudUpdates()
  }

  function modelSelectorState(): SelectorState {
    return createModelWindow(st.configInfo, deps.agent.model)
  }

  function skillSelectorState(): SelectorState {
    st.skillEntries = getSkillEntries(deps.agent.skillsDirs())
    return { ...createSkillSelectorState(st.skillEntries), listFocused: false }
  }

  function resumeSelectorState(items: SelectorItem[], initialQuery?: string): SelectorState {
    // An explicitly opened list owns `e`/`d`; the command preview below does not.
    return createResumeWindow(items, initialQuery, true)
  }

  /** The `/share` list keeps its details pane: the link it is opened for lives there. */
  function cloudSelectorState(items: SelectorItem[]): SelectorState {
    return createResumeWindow(items, undefined, true, true)
  }

  function currentResumeCommandWindowState(generation: number): SelectorState | null {
    if (generation !== st.commandWindowPreviewGeneration) return null
    if (
      st.commandWindowPreview?.kind === 'selector'
      && st.commandWindowPreview.trigger === 'resume'
      && st.commandWindowPreview.generation === generation
      && resolveCommandWindowTrigger(st.commandWindowPreview.sourceText) === 'resume'
    ) {
      return st.commandWindowPreview.state
    }
    if (
      st.focusedCommandWindowGeneration === generation
      && st.overlay.kind === 'selector'
      && st.overlay.state.owner === SELECTOR_OWNER.resume
      && st.overlay.state.sessionScope !== 'cloud'
    ) {
      return st.overlay.state
    }
    return null
  }

  function updateResumeCommandWindow(generation: number, state: SelectorState): boolean {
    if (generation !== st.commandWindowPreviewGeneration) return false
    if (
      st.commandWindowPreview?.kind === 'selector'
      && st.commandWindowPreview.trigger === 'resume'
      && st.commandWindowPreview.generation === generation
    ) {
      st.commandWindowPreview = { ...st.commandWindowPreview, state }
      deps.renderer.requestRender()
      return true
    }
    if (
      st.focusedCommandWindowGeneration === generation
      && st.overlay.kind === 'selector'
      && st.overlay.state.owner === SELECTOR_OWNER.resume
      && st.overlay.state.sessionScope !== 'cloud'
    ) {
      st.overlay = { kind: 'selector', state }
      deps.renderer.requestRender()
      return true
    }
    return false
  }

  function resumeSelectorStateFromCache(): SelectorState {
    // Keep every keystroke bounded: the composer preview is recognition aid,
    // not the full search surface. Never format transcript text here, and cap
    // metadata work to the same recent-session budget used at startup.
    const snapshot = deps.resumeCache.metadata ?? []
    if (snapshot.length > 0) {
      const items = deps.resumeItems.format(
        { sessions: snapshot, cwd: deps.agent.cwd, textVersion: deps.resumeCache.textVersion, limit: 20, openSessionId: st.sessionId },
        id => deps.resumeCache.sessionText(id),
      )
      return resumeSelectorState(items)
    }
    if (deps.resumeCache.complete) {
      return {
        ...createResumeWindow([]),
        emptyMessage: 'No sessions found',
      }
    }
    return {
      ...createResumeWindow([]),
      emptyMessage: 'Loading sessions…',
    }
  }

  function applyResumeSessions(
    generation: number,
    sessions: SessionMeta[],
    limit?: number,
  ): boolean {
    const current = currentResumeCommandWindowState(generation)
    if (!current || current.rename) return false
    const items = deps.resumeItems.format(
      { sessions, cwd: deps.agent.cwd, textVersion: deps.resumeCache.textVersion, limit, openSessionId: st.sessionId },
      id => deps.resumeCache.sessionText(id),
    )
    const {
      emptyMessage: _loadingMessage,
      subtitle: _loadingSubtitle,
      ...readyState
    } = current
    const expanded = selectorExpandItems(readyState, items)
    const hasAnySession = items.some(item => !item.header)
    const next = expanded.items.length > 0
      ? expanded
      : {
          ...expanded,
          emptyMessage: hasAnySession
            ? 'No sessions in current cwd · type to search all sessions'
            : 'No sessions found',
        }
    const applied = updateResumeCommandWindow(generation, next)
    if (applied) {
      loadFocusedResumePreview(next)
    }
    return applied
  }

  function cancelResumeCommandLoad(): void {
    if (!st.resumeCommandLoadTimer) return
    clearTimeout(st.resumeCommandLoadTimer)
    st.resumeCommandLoadTimer = undefined
  }

  /** Stop every command preview's background work: a window is going away
   *  or changing identity, so nothing started for it may repaint. */
  function cancelCommandWindowLoads(): void {
    cancelResumeCommandLoad()
    st.unmountTaskPreview?.()
    st.unmountTaskPreview = null
    st.unmountComputePreview?.()
    st.unmountComputePreview = null
  }

  /** Mount the Task list under the composer. The session repaints through
   *  the listener for as long as it stays mounted: typing on within `/task`
   *  rekeys the window's generation but keeps this mount, and every teardown
   *  goes through `cancelCommandWindowLoads`, so no generation check is
   *  needed here. */
  function taskPreviewState(): SelectorState {
    const mounted = deps.taskSession.preview(() => {
      if (st.commandWindowPreview?.kind === 'selector' && st.commandWindowPreview.trigger === 'task') {
        st.commandWindowPreview = { ...st.commandWindowPreview, state: deps.taskSession.previewState() }
        deps.renderer.requestRender()
      }
    })
    st.unmountTaskPreview = mounted.unmount
    return mounted.state
  }

  /** Mount the Compute list under the composer, exactly as for /task. */
  function computePreviewState(): SelectorState {
    const mounted = deps.computeSession.preview(() => {
      if (st.commandWindowPreview?.kind === 'selector' && st.commandWindowPreview.trigger === 'compute') {
        st.commandWindowPreview = { ...st.commandWindowPreview, state: deps.computeSession.previewState() }
        deps.renderer.requestRender()
      }
    })
    st.unmountComputePreview = mounted.unmount
    return mounted.state
  }

  function isActiveResumePreview(generation: number): boolean {
    return generation === st.commandWindowPreviewGeneration
      && st.commandWindowPreview?.kind === 'selector'
      && st.commandWindowPreview.trigger === 'resume'
      && st.commandWindowPreview.generation === generation
      && resolveCommandWindowTrigger(st.commandWindowPreview.sourceText) === 'resume'
  }

  function scheduleResumeCommandLoad(generation: number): void {
    cancelResumeCommandLoad()
    if (!isActiveResumePreview(generation)) return

    const current = currentResumeCommandWindowState(generation)
    if (current && deps.resumeCache.metadata === null) {
      updateResumeCommandWindow(
        generation,
        current.items.length === 0
          ? { ...current, emptyMessage: 'Loading sessions…' }
          : { ...current, subtitle: 'Loading sessions…' },
      )
    }

    // The loading frame is requested above. Start native work only after a
    // short keyboard-idle window. Every edit rekeys the mounted preview, so an
    // older native result cannot repaint a newer `/re` → `/` transition.
    //
    // Paint the bounded cache first, then expand metadata from the complete
    // catalog in place. The startup cache is global-recency based: after cwd
    // filtering it may contain only a couple of rows even though this project
    // has much more history. Stopping at that cache made the live command
    // window disagree with the selector opened by Enter.
    st.resumeCommandLoadTimer = setTimeout(() => {
      st.resumeCommandLoadTimer = undefined
      if (!isActiveResumePreview(generation)) return
      void deps.resumeCache.preview().then(sessions => {
        if (!isActiveResumePreview(generation)) return
        applyResumeSessions(generation, sessions, 20)

        void deps.resumeCache.all().then(allSessions => {
          if (!isActiveResumePreview(generation)) return
          if (applyResumeSessions(generation, allSessions)) {
            st.enrichedResumeMetadataGeneration = generation
          }
        }).catch(() => {
          // The bounded preview is already usable. A failed enrichment should
          // not replace real rows with an error; only clear its loading label.
          if (!isActiveResumePreview(generation)) return
          const state = currentResumeCommandWindowState(generation)
          if (!state) return
          updateResumeCommandWindow(generation, { ...state, subtitle: undefined })
        })
      }).catch(() => {
        if (!isActiveResumePreview(generation)) return
        const state = currentResumeCommandWindowState(generation)
        if (!state) return
        updateResumeCommandWindow(generation, {
          ...state,
          emptyMessage: 'Failed to list sessions',
          subtitle: undefined,
        })
      })
    }, 160)
  }

  function cancelSearchTextWarm(): void {
    if (!st.cancelSearchTextWarmup) return
    st.cancelSearchTextWarmup()
    st.cancelSearchTextWarmup = null
  }

  /**
   * Convert transcript search text to lowercase ahead of the first keystroke.
   *
   * Filtering needs a lowercased copy of every row. Building it on demand put
   * the whole 14M-character conversion on whichever keystroke came first, which
   * read as a stall right after the list finished loading. Warming in idle
   * slices moves that off the typing path entirely.
   */
  function startSearchTextWarm(items: SelectorItem[]): void {
    cancelSearchTextWarm()
    st.cancelSearchTextWarmup = warmSearchableText(items)
  }

  function cancelResumeSearchEnrichment(): void {
    if (!st.resumeSearchEnrichmentTimer) return
    clearTimeout(st.resumeSearchEnrichmentTimer)
    st.resumeSearchEnrichmentTimer = undefined
  }

  function scheduleFocusedResumeEnrichment(generation: number, includeText = false): void {
    // Share uses the same navigation owner, but must never load the full
    // local catalog when arrow keys or search request resume enrichment.
    if (!currentResumeCommandWindowState(generation)) return
    cancelResumeCommandLoad()
    cancelResumeSearchEnrichment()
    if (
      includeText
        ? st.enrichedResumeTextGeneration === generation
        : st.enrichedResumeMetadataGeneration === generation
    ) return

    // Keep keyboard response ahead of storage work. The bounded 20-row preview
    // is already usable; only after a short input idle do we expand metadata.
    // Complete caches still pass through this idle boundary: reopening `/re`
    // starts compact, then expands from memory without native I/O. Transcript
    // parsing is deferred until a typed filter can benefit from full text.
    st.resumeSearchEnrichmentTimer = setTimeout(() => {
      st.resumeSearchEnrichmentTimer = undefined
      if (!currentResumeCommandWindowState(generation)) return

      const metadata = deps.resumeCache.all()
      void metadata.then(sessions => {
        if (!applyResumeSessions(generation, sessions)) return
        st.enrichedResumeMetadataGeneration = generation
        if (!includeText) return

        return deps.resumeCache.text().then(sessionsWithText => {
          const current = currentResumeCommandWindowState(generation)
          if (!current || current.rename) return
          const fullItems = deps.resumeItems.format(
            { sessions: sessionsWithText, cwd: deps.agent.cwd, textVersion: deps.resumeCache.textVersion, openSessionId: st.sessionId },
            id => deps.resumeCache.sessionText(id),
          )
          if (updateResumeCommandWindow(generation, selectorExpandItems(current, fullItems))) {
            st.enrichedResumeTextGeneration = generation
            // Transcript text just became searchable. Lowercase it in idle
            // slices so the first keystroke does not pay for the whole pool.
            startSearchTextWarm(fullItems)
          }
        })
      }).catch(() => {
        const current = currentResumeCommandWindowState(generation)
        if (!current) return
        updateResumeCommandWindow(generation, {
          ...current,
          emptyMessage: 'Failed to list sessions',
        })
      })
    }, 160)
  }

  /**
   * The resume list currently on screen, with the setter that owns it.
   *
   * A resume list lives either in the composer preview or in the promoted
   * overlay. Both need the focused row's preview filled in, so the loader
   * addresses whichever one is mounted instead of only the overlay.
   */
  function resumeSurface(): { state: SelectorState; apply: (state: SelectorState) => void } | null {
    if (st.commandWindowPreview?.kind === 'selector' && st.commandWindowPreview.trigger === 'resume') {
      const mounted = st.commandWindowPreview
      return { state: mounted.state, apply: state => { st.commandWindowPreview = { ...mounted, state } } }
    }
    if (st.overlay.kind === 'selector' && st.overlay.state.owner === SELECTOR_OWNER.resume) {
      return { state: st.overlay.state, apply: state => { st.overlay = { kind: 'selector', state } } }
    }
    return null
  }

  /**
   * Fill the focused row's preview from its own transcript.
   *
   * The pane shows one session at a time, so only that session is read. Reading
   * the whole catalog to render one pane costs a transcript read per session,
   * which on a large history left the pane empty long enough to look broken.
   */
  function loadFocusedResumePreview(state: SelectorState): void {
    if (state.rename) return
    const focused = state.items[state.focusIndex]
    // One-line rows have no pane to fill; skip the transcript read.
    if (!focused || focused.header || !focused.id || !focused.preview) return
    const id = focused.id
    void deps.resumeCache.loadSessionText(id).then(text => {
      if (!text) return
      const surface = resumeSurface()
      const stillFocused = surface?.state.items[surface.state.focusIndex]
      // Focus moved on, or the list was replaced: a later focus reloads from
      // the cache, so there is nothing to reconcile here.
      if (!surface || surface.state.rename || !stillFocused || stillFocused.id !== id) return
      surface.apply(selectorReplaceItem(surface.state, id,
        applySessionText(stillFocused, text, deps.agent.cwd, st.sessionId, surface.state.sessionScope === 'cloud')))
      deps.renderer.requestRender()
    })
  }

  function refreshCommandWindowPreview(allowMount: boolean): void {
    if (st.overlay.kind !== 'none' || st.isLoading || deps.queueEdit.editingEntry()) {
      // A promoted command window continues to own its generation so an
      // in-flight resume load can update the focused selector. Other overlays
      // invalidate any stale preview request.
      if (st.commandWindowPreview) {
        st.commandWindowPreview = null
        cancelCommandWindowLoads()
        nextCommandWindowGeneration()
        releaseCommandWindowLayout()
      } else if (st.focusedCommandWindowGeneration === null) {
        nextCommandWindowGeneration()
      }
      return
    }

    // Nothing is mounted, so the only possible outcome is mounting a new
    // window. Reserve that for typing: ↑/↓ recalling `/model` from history or
    // pasting it must not pop the window above the composer.
    if (st.commandWindowPreview === null && !allowMount) return

    const sourceText = getEditorText(st.editor)
    const trigger = resolveCommandWindowTrigger(sourceText)
    if (!trigger) {
      if (st.commandWindowPreview && isCommandWindowBridge(sourceText)) {
        // Keep the mounted window through an ambiguous slash prefix. Rekey it
        // so any session request started for the previous spelling may fill
        // caches but can no longer repaint this bridge frame.
        const preview = st.commandWindowPreview
        const generation = nextCommandWindowGeneration()
        st.commandWindowPreview = { ...preview, sourceText, generation }
        cancelCommandWindowLoads()
        deps.renderer.requestRender()
        return
      }
      if (st.commandWindowPreview) {
        st.commandWindowPreview = null
        cancelCommandWindowLoads()
        nextCommandWindowGeneration()
        releaseCommandWindowLayout()
        deps.renderer.requestRender()
      }
      return
    }
    if (st.commandWindowPreview?.trigger === trigger) {
      const preview = st.commandWindowPreview
      if (preview.sourceText === sourceText) return
      const generation = nextCommandWindowGeneration()
      st.commandWindowPreview = { ...preview, sourceText, generation }
      deps.renderer.requestRender()
      if (trigger === 'resume') scheduleResumeCommandLoad(generation)
      if (trigger === 'share') loadShareCommandWindow(generation)
      return
    }

    cancelCommandWindowLoads()
    const generation = nextCommandWindowGeneration()
    if (trigger === 'help') {
      st.commandWindowPreview = { kind: 'help', trigger, sourceText, generation }
      deps.renderer.requestRender()
      return
    }
    if (trigger === 'model') {
      st.commandWindowPreview = {
        kind: 'selector',
        trigger,
        sourceText,
        generation,
        state: modelSelectorState(),
      }
      deps.renderer.requestRender()
      return
    }
    if (trigger === 'skill') {
      st.commandWindowPreview = {
        kind: 'selector',
        trigger,
        sourceText,
        generation,
        state: skillSelectorState(),
      }
      deps.renderer.requestRender()
      return
    }
    if (trigger === 'share') {
      st.commandWindowPreview = {
        kind: 'selector', trigger, sourceText, generation,
        state: {
          ...cloudSelectorState([]), title: 'Cloud sessions', sessionScope: 'cloud', listFocused: false,
          emptyMessage: 'Loading sessions…',
        },
      }
      deps.renderer.requestRender()
      loadShareCommandWindow(generation)
      return
    }
    if (trigger === 'task') {
      st.commandWindowPreview = {
        kind: 'selector',
        trigger,
        sourceText,
        generation,
        state: taskPreviewState(),
      }
      deps.renderer.requestRender()
      return
    }
    if (trigger === 'compute') {
      st.commandWindowPreview = {
        kind: 'selector',
        trigger,
        sourceText,
        generation,
        state: computePreviewState(),
      }
      deps.renderer.requestRender()
      return
    }

    st.commandWindowPreview = {
      kind: 'selector',
      trigger,
      sourceText,
      generation,
      // The composer holds the text here, so typing stays search.
      state: { ...resumeSelectorStateFromCache(), listFocused: false },
    }
    deps.renderer.requestRender()
    scheduleResumeCommandLoad(generation)
  }

  /** The cloud list previews while typing, without invoking /share actions. */
  function loadShareCommandWindow(generation: number): void {
    const current = (): SelectorState | null => {
      if (generation !== st.commandWindowPreviewGeneration) return null
      if (st.commandWindowPreview?.kind === 'selector'
        && st.commandWindowPreview.trigger === 'share'
        && st.commandWindowPreview.generation === generation
        && resolveCommandWindowTrigger(st.commandWindowPreview.sourceText) === 'share') {
        return st.commandWindowPreview.state
      }
      if (st.focusedCommandWindowGeneration === generation
        && st.overlay.kind === 'selector' && st.overlay.state.owner === SELECTOR_OWNER.resume
        && st.overlay.state.sessionScope === 'cloud') {
        return st.overlay.state
      }
      return null
    }
    const repaint = () => {
      const state = current()
      if (!state) return
      const sessions = mergeRemoteSessions(deps.resumeCache.metadata ?? [], deps.cloudSessions.remoteSessions)
        .filter(session => deps.sessionCloudLabel(session) !== '')
      // Every shared session, whichever project or machine it came from.
      const items = formatSessionItems(sessions, deps.agent.cwd, id => deps.resumeCache.sessionText(id), st.sessionId, deps.sessionCloudLabel,
        { showOtherCwds: true, cloudFirst: true })
      const next = {
        ...selectorExpandItems(state, items),
        emptyMessage: 'No shared sessions yet · /share private to sync, /share public to publish',
      }
      if (st.commandWindowPreview?.kind === 'selector' && st.commandWindowPreview.trigger === 'share') {
        st.commandWindowPreview = { ...st.commandWindowPreview, state: next }
      } else {
        st.overlay = { kind: 'selector', state: next }
      }
      deps.renderer.requestRender()
    }
    st.refreshOpenSessionList = repaint
    void Promise.all([deps.resumeCache.all(), deps.cloudSessions.refreshIndex()]).then(repaint).catch((error: unknown) => {
      const state = current()
      if (!state) return
      const next = { ...state, emptyMessage: `Failed to list sessions: ${errorText(error)}` }
      if (st.commandWindowPreview?.kind === 'selector' && st.commandWindowPreview.trigger === 'share') {
        st.commandWindowPreview = { ...st.commandWindowPreview, state: next }
      } else {
        st.overlay = { kind: 'selector', state: next }
      }
      deps.renderer.requestRender()
    })
  }

  function activateCommandWindow(event: KeyEvent): boolean {
    if (event.type !== 'up' && event.type !== 'down') return false
    if (!st.commandWindowPreview) return false

    const preview = st.commandWindowPreview
    st.focusedCommandWindowGeneration = preview.generation
    if (preview.kind === 'selector') {
      // Use the same navigation path as an open selector so the first arrow
      // both focuses the list and moves from the preview's highlighted row.
      const action = handleSelectorControl(preview.state, event, deps.renderer.termCols, deps.renderer.termRows, st.selectorPreviewViewport)
      if (action.kind !== 'update') return false
      st.overlay = { kind: 'selector', state: action.state }
    } else {
      st.overlay = { kind: 'help' }
    }
    st.commandWindowPreview = null
    // Help remains a modal rather than participating in the stable
    // selector/composer layout. Consume its command on activation so closing
    // the modal cannot immediately recreate the same preview from `/help`.
    // Once the task picker owns the keyboard, `/task` is no longer a draft.
    // Leaving it in the editor made a background task edit look like it was
    // responding while the same command was still waiting to be submitted.
    if (preview.kind === 'help' || preview.trigger === 'task' || preview.trigger === 'compute') deps.clearAll()
    deps.renderer.requestRender()
    if (preview.trigger === 'resume') {
      scheduleFocusedResumeEnrichment(preview.generation)
      if (st.overlay.kind === 'selector') {
        loadFocusedResumePreview(st.overlay.state)
      }
    }
    if (preview.trigger === 'share' && st.overlay.kind === 'selector') {
      loadFocusedResumePreview(st.overlay.state)
    }
    if (preview.trigger === 'task') {
      // The list is now the overlay: from here the session owns refresh,
      // detail loading and keys exactly as after `/task` + Enter.
      st.unmountTaskPreview?.()
      st.unmountTaskPreview = null
      if (st.overlay.kind === 'selector') deps.taskSession.open(st.overlay.state.items[st.overlay.state.focusIndex]?.id)
    }
    if (preview.trigger === 'compute') {
      st.unmountComputePreview?.()
      st.unmountComputePreview = null
      if (st.overlay.kind === 'selector') deps.computeSession.open(st.overlay.state.items[st.overlay.state.focusIndex]?.id)
    }
    return true
  }

  return { activateCommandWindow, cancelCommandWindowLoads, cancelResumeSearchEnrichment, cancelSearchTextWarm, cloudSelectorState, commandWindowMounted, loadFocusedResumePreview, nextCommandWindowGeneration, refreshCommandWindowPreview, releaseCommandWindowLayout, resumeSelectorState, scheduleFocusedResumeEnrichment }
}
