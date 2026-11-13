import { tabAction, tabActionHint } from '../app/composer/input-action.js'
import { pendingQueueHint } from '../app/queue/queue-manage.js'
import { currentQueueTarget, pendingEntryLabel, visiblePendingEntries } from '../app/queue/pending-queue.js'
import type { SuggestController } from './suggest.js'
import type { LoopSession } from '../../features/loop/session.js'
import { formatLoopWaitLine } from '../../features/loop/wait-line.js'
import type { Agent } from '../../native/index.js'
import { assistantMessageToOutputLines } from '../../render/assistant.js'
import type { UIAssistantBlock, UIToolCall } from '../../render/message-types.js'
import type { OutputLine } from '../../render/output.js'
import type { BackgroundTerminals } from '../app/background/background-terminals.js'
import { assistantToolCalls } from '../app/run/assistant-content.js'
import type { ManualCompaction } from '../app/run/manual-compaction.js'
import type { RunInteraction, RunInteractionInput } from '../app/run/run-interaction.js'
import type { PromptSuggestion, SuggestionTicker } from '../app/suggestion/index.js'
import type { GitInfoProvider } from '../git-info.js'
import type { CommandWindowController } from './command-window.js'
import type { ReplState } from './state.js'
import type { RenderFrame } from '../screen/render-frame.js'
import type { RenderWakeup } from '../screen/render-wakeup.js'
import type { TermRenderer } from '../screen/renderer.js'
import { buildAdSlotBlocks, nextAdSlotRenderDelay, tickAdSlot } from '../viewmodel/ad-slot.js'
import type { HistoryRenderCache } from '../viewmodel/history-cache.js'
import { type PromptVMInput, type ViewBlock, blocksToLines, buildOutputBlocks, formatQueuedMessageLines, updateLiveHeight } from '../viewmodel/index.js'
import { promptFromSnapshot } from '../viewmodel/prompt-snapshot.js'
import { type AwaitedTasks, buildRunStatusBlock } from '../viewmodel/run-status.js'
import { buildShellFrame } from '../viewmodel/shell.js'
import { attachUpdateNotice, standaloneUpdateNotice, updateNoticeSpans } from '../viewmodel/update-notice.js'
import type { BannerCache } from '../widgets/banner-cache.js'
import { compactionToolName, formatSpinnerLine, spinnerStatsFromLastUsage } from '../widgets/spinner.js'
import { SELECTOR_OWNER } from '../../ui/selector-identity.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface FrameDeps {
  readonly adSlotWakeup: RenderWakeup
  readonly agent: Agent
  readonly appVersion: string
  readonly awaitedTaskSummary: (calls: UIToolCall[]) => AwaitedTasks | undefined
  readonly backgroundTerminals: BackgroundTerminals
  readonly bannerCache: BannerCache
  readonly commandWindow: CommandWindowController
  readonly compactHistoryCache: HistoryRenderCache
  readonly compactLines: OutputLine[]
  readonly expandedHistoryCache: HistoryRenderCache
  readonly expandedLines: OutputLine[]
  readonly gitInfo: GitInfoProvider
  readonly loopSession: LoopSession
  readonly manualCompaction: ManualCompaction
  readonly renderer: TermRenderer
  readonly runInteraction: RunInteraction
  readonly runInteractionInput: () => RunInteractionInput
  readonly suggest: SuggestController
  readonly suggestions: PromptSuggestion
  readonly suggestionTicker: SuggestionTicker
}

export interface FrameController {
  buildFrame(): RenderFrame
  refreshBannerData(): void
  resetHistoryCache(): void
}

/** Builds each terminal frame from state: prompt view-model, banner, live assistant blocks and overlays. */
export function createFrameController(st: ReplState, deps: FrameDeps): FrameController {
  function resetHistoryCache() {
    deps.compactHistoryCache.reset()
    deps.expandedHistoryCache.reset()
    // A rebuild can lay the same history out at a different height.
    st.committedPrefixMayReshape = true
  }

  function getPromptVM(): PromptVMInput {
    deps.suggestions.reconcile()
    const interaction = deps.runInteraction.snapshot(deps.runInteractionInput())
    // While a loop is parked, Esc stops the loop (the placeholder says so),
    // so the chip must not advertise a second meaning for the same key.
    const loopParked = interaction.kind === 'waiting-loop'
    const backgroundStopHint = st.overlay.kind !== 'none' || st.editor.completion || loopParked ? undefined
      : interaction.kind === 'waiting-background' && interaction.backgroundStopping ? 'Stopping…'
      : interaction.interruptTarget === 'background'
        ? interaction.interruptPending ? `esc again to stop all ${interaction.backgroundTasks} task${interaction.backgroundTasks === 1 ? '' : 's'}` : 'esc twice to stop all'
        : undefined
    const prompt = promptFromSnapshot({
      editor: st.editor,
      session: st.appState,
      config: st.configInfo,
      active: st.overlay.kind === 'none',
      logMode: st.logMode !== null,
      dashboardUrl: st.serverState?.address ?? null,
      exitHint: st.exitHint,
      columns: deps.renderer.termCols,
      rows: deps.renderer.termRows,
      gitBranch: deps.gitInfo.getBranch(),
      backgroundProcessCount: deps.backgroundTerminals.runningCount(),
      backgroundStopHint,
      backgroundStopPending: interaction.interruptPending,
      busy: st.isLoading,
      interaction,
      suggestion: deps.suggestions.completing() ? '' : deps.suggestions.text(),
      suggestionPosition: deps.suggestions.position(),
      suggestionCompletion: deps.suggestions.completing() ? deps.suggestions.text() : '',
      suggestionReplacing: deps.suggestions.replacing(),
      suggestionStatus: deps.suggestions.feedback(),
      suggestionExplicit: deps.suggestions.isExplicit(),
      suggestionFrame: deps.suggestionTicker.frame,
      loopParked,
      queuedCount: visiblePendingEntries(st.pendingQueue, currentQueueTarget(st)).length,
    })
    const pending = visiblePendingEntries(st.pendingQueue, currentQueueTarget(st))
    const action = tabAction(st.editor, { busy: st.isLoading, editing: !!st.queueEditState, skills: st.skillEntries, inventory: deps.suggest.suggestionInventory() })
    const inputHint = st.overlay.kind !== 'none' ? undefined
      : st.queueEditState ? (st.queueEditState.consumed ? 'Original sent · copy changes or Esc discard' : 'Enter save · Esc discard')
      : st.pendingEnqueue ? 'Preparing images · editing cancels enqueue'
      : tabActionHint(action) ?? (pending.length ? pendingQueueHint(pending.filter(entry => entry.paused).length) : undefined)
    return { ...prompt, inputHint }
  }
  function refreshBannerData(): void {
    if (deps.bannerCache.refresh(deps.agent.cwd, deps.agent.skillsDirs())) deps.renderer.requestRender()
  }

  function currentBannerText(): string {
    return deps.bannerCache.render({
      version: deps.appVersion,
      model: deps.agent.model,
      cwd: deps.agent.cwd,
      configInfo: st.configInfo,
      columns: deps.renderer.termCols,
      rows: deps.renderer.termRows,
      serverState: st.serverState,
      releaseNotes: st.releaseNotes,
      installDrift: st.installDrift,
      startupWarning: deps.agent.startupWarning,
    })
  }

  // --- buildFrame: the single render callback for the new differential renderer ---
  // Live-partial memo: spinner ticks (10/s) and keystrokes repaint the frame
  // without changing the assistant content. The reducer replaces the content
  // array on every real change, so reference equality is an exact dirty check
  // and pure-repaint frames skip the Markdown pipeline entirely.
  const EMPTY_ASSISTANT_CONTENT: UIAssistantBlock[] = []

  function buildPartialAssistantBlocks(prevKind: string | undefined): ViewBlock[] {
    const content = st.streamMachine?.appState.currentAssistantContent ?? EMPTY_ASSISTANT_CONTENT
    // Only provider deltas are provisional. The entire partial message stays in
    // the dynamic zone and is reparsed on every content delta, matching pi: a
    // growing table can update its rows and column geometry through line diffs.
    const streaming = st.spinnerState.streaming
    const columns = deps.renderer.termCols
    if (
      st.partialBlocksMemo
      && st.partialBlocksMemo.content === content
      && st.partialBlocksMemo.expanded === st.expanded
      && st.partialBlocksMemo.streaming === streaming
      && st.partialBlocksMemo.columns === columns
      && st.partialBlocksMemo.prevKind === prevKind
    ) {
      return st.partialBlocksMemo.blocks
    }
    // Use the exact ordered committed-output pipeline for the live partial,
    // including the committed tail's kind as layout context. This keeps
    // thinking/text/tool positions, margins, and prefixes byte-identical through
    // completion, so committing the message never changes any rendered row.
    // The one exception is a reasoning block that is still streaming when the
    // run ends: its tail window collapses to a summary row at commit, which the
    // renderer absorbs as an in-viewport shrink above the footer.
    const blocks = buildOutputBlocks(assistantMessageToOutputLines(content, st.expanded, {
      streaming,
    }), {
      prevKind,
      columns,
    })
    st.partialBlocksMemo = { content, expanded: st.expanded, streaming, columns, prevKind, blocks }
    return blocks
  }

  function buildFrame(): RenderFrame {
    if (st.destroyed) return { lines: [] }

    // An overlay owns the screen, so hold the caret solid rather than
    // animating behind a modal.

    // 1. Banner
    const banner = currentBannerText()
    const bannerLines = banner ? banner.split('\n') : []

    // 2. History (committed output lines) — incrementally cached so the
    // high-frequency spinner/delta/keystroke renders skip re-flattening the
    // whole transcript. The cache extends in place on append and rebuilds only
    // on reset (clear/replace), width change, or shrink. See HistoryRenderCache.
    const cols = deps.renderer.termCols
    const widthChanged = cols !== st.liveContentWidth
    if (widthChanged) {
      st.liveContentWidth = cols
      st.liveContentMaxHeight = 0
    }
    const cache = st.expanded ? deps.expandedHistoryCache : deps.compactHistoryCache
    const cachedHistoryLines = cache.sync(st.expanded ? deps.expandedLines : deps.compactLines, cols)
    const bannerRows = bannerLines.length
    // Rows above this index are committed transcript; render diagnostics use it
    // to attribute a repaint to history, the live partial, or the live region.
    st.historyRowCount = bannerRows + cachedHistoryLines.length
    // The renderer cannot patch scrollback, so a prefix that shifts instead of
    // appending must be announced or it leaves a duplicated row and a lost one.
    if (st.committedBannerRows !== null) {
      const shifted = bannerRows !== st.committedBannerRows
        || cachedHistoryLines.length < st.committedHistoryRows
        || (st.committedPrefixMayReshape && cachedHistoryLines.length !== st.committedHistoryRows)
      // A resize reflows the viewport without replaying history. Explicit
      // edits still take precedence, including an edit concurrent with resize.
      if (shifted && (!widthChanged || st.committedPrefixMayReshape)) deps.renderer.invalidateScrollback()
    }
    st.committedBannerRows = bannerRows
    st.committedHistoryRows = cachedHistoryLines.length
    st.committedPrefixMayReshape = false

    // 3. Ordered partial assistant message (thinking/text/tool calls). Markdown
    // prefixes can legitimately reparse into fewer rows as a fence/list/table
    // becomes complete. Track history + partial as one region: when completion
    // moves the same content from partial into history its total height remains
    // continuous, and any transient parser shrink is absorbed above the footer.
    const partialLines = blocksToLines(buildPartialAssistantBlocks(cache.trailingKind))
    const livePartialHeight = partialLines.length
    const liveContentHeight = cachedHistoryLines.length + livePartialHeight
    // The monotonic-height guard is only needed while visible partial content is
    // being reparsed. At the start of a fresh LLM call currentAssistantContent is
    // empty; retaining the previous call's peak then creates up to eight literal
    // blank rows above Thinking…. Reset immediately until the first visible block.
    const liveHeight = updateLiveHeight(
      st.liveContentMaxHeight,
      liveContentHeight,
      st.isLoading && livePartialHeight > 0,
    )
    st.liveContentMaxHeight = liveHeight.maxHeight
    const paddingLines: string[] = liveHeight.padding > 0
      ? new Array<string>(liveHeight.padding).fill('')
      : []

    // The cached history is already flattened ANSI; it joins the frame as-is.
    // Re-wrapping it in spans and re-flattening every frame costs three
    // allocations and a fresh string per transcript row, which in a long
    // session is tens of milliseconds and hundreds of MB/s of garbage. The
    // renderer reuses the same string objects to skip finalizing those rows.
    const latestContentLines = bannerLines.concat(cachedHistoryLines, partialLines, paddingLines)
    const commandWindowIsMounted = deps.commandWindow.commandWindowMounted()
    if (
      commandWindowIsMounted
      && (st.commandWindowContentLines === null || st.commandWindowContentWidth !== cols)
    ) {
      // Background commits stay frozen while the command window is mounted,
      // but a resize must rebuild wrapping before the renderer repaints the
      // new viewport without replaying history.
      st.commandWindowContentLines = latestContentLines
      st.commandWindowContentWidth = cols
    }
    const contentLines = commandWindowIsMounted
      ? st.commandWindowContentLines ?? latestContentLines
      : latestContentLines
    // Everything below the committed transcript is repaintable, whichever
    // branch below builds it. A mounted command window freezes this boundary,
    // so late history/status commits cannot move its selector or composer.
    st.liveRegionStartRow = contentLines.length
    const toolCalls = assistantToolCalls(st.streamMachine?.appState.currentAssistantContent ?? [])
    let spinnerBlock: ViewBlock | null = null
    // pi keeps statusContainer before editorContainer, so the active-run status
    // remains visible even while a selector replaces the editor.
    if (st.isLoading && st.overlay.kind !== 'ask-user') {
      const usagePending = st.streamMachine?.activeLlmCall ?? false
      const liveOutputTokens = usagePending && toolCalls.length === 0 ? st.spinnerState.tokenCount : 0
      // Usage arrives only when the provider completes this call. During an
      // active call, show only its live output estimate; retaining the previous
      // call here would present stale cache/input values as if they were current.
      const compactToolName = compactionToolName(st.manualCompactionPhase, st.manualCompactionActivity)
      const spinnerForDisplay = deps.manualCompaction.active
        ? { ...st.spinnerState, toolName: compactToolName }
        : st.spinnerState
      const spinnerText = formatSpinnerLine(
        spinnerForDisplay,
        Date.now(),
        // Manual compaction and local commands report no per-call usage of their
        // own; showing the previous run's tokens would misattribute them.
        deps.manualCompaction.active || st.foregroundCommand
          ? undefined
          : spinnerStatsFromLastUsage(
              st.appState.currentRunStats.lastLlmUsage,
              liveOutputTokens,
              usagePending,
            ),
        {
          model: st.appState.model,
          columns: deps.renderer.termCols,
          interaction: deps.runInteraction.snapshot(deps.runInteractionInput()),
          awaitedTasks: deps.awaitedTaskSummary(toolCalls),
        },
      )
      spinnerBlock = buildRunStatusBlock(spinnerText, deps.renderer.termCols)
    } else if (!st.isLoading && st.overlay.kind !== 'ask-user' && deps.loopSession.waiting) {
      // Parked between loop ticks. The wakeup card in the transcript says why;
      // this row says until when, and that a running shell can end it early.
      const wait = deps.loopSession.waitRemaining()
      if (wait) {
        const waitText = formatLoopWaitLine({
          remainingMs: wait.remainingMs,
          earlyWake: wait.earlyWake,
          stopPending: deps.runInteraction.snapshot(deps.runInteractionInput()).interruptPending,
        })
        spinnerBlock = buildRunStatusBlock(waitText, deps.renderer.termCols)
      }
    } else if (st.backgroundWaitSince !== null && st.overlay.kind !== 'ask-user') {
      //
      // Idle, but a detached task is still running and will wake the agent when
      // it finishes. Without a status row here the transcript looks finished, so
      // a user watching a long build would conclude the work had stopped.
      //
      // Elapsed is measured from when the wait began, not from the last run, so
      // the clock reads as the age of the wait itself.
      const waitText = formatSpinnerLine(
        { ...st.backgroundWaitSpinner, phaseStartedAt: st.backgroundWaitSince },
        Date.now(),
        // No per-call usage belongs to a wait: nothing is being spent while the
        // agent is parked.
        undefined,
        { model: st.appState.model, columns: deps.renderer.termCols, interaction: deps.runInteraction.snapshot(deps.runInteractionInput()), hideInteractionHint: true },
      )
      spinnerBlock = buildRunStatusBlock(waitText, deps.renderer.termCols)
    }

    // Match pi's sibling order before editorContainer: pending messages, then
    // status. The queue manager suppresses the duplicate pending-message copy
    // because the selector itself is displaying those same entries.
    // One lifecycle tick and one optional wakeup per frame. Static text sleeps
    // until its rotation deadline instead of repainting at animation cadence.
    const adSlotNow = Date.now()
    const adSlotTick = tickAdSlot(st.adSlot, adSlotNow)
    deps.adSlotWakeup.replace(nextAdSlotRenderDelay(st.adSlot, adSlotTick, adSlotNow,
      st.overlay.kind === 'none' && !st.isLoading && !spinnerBlock
      && !commandWindowIsMounted && deps.renderer.termCols >= 30))
    const preEditorBlocks: ViewBlock[] = []
    const queueManagerOpen = st.overlay.kind === 'selector' && st.overlay.state.owner === SELECTOR_OWNER.queue
    const pendingNow = visiblePendingEntries(st.pendingQueue, currentQueueTarget(st))
    const queueLines = queueManagerOpen
      ? []
      : formatQueuedMessageLines(pendingNow.map(pendingEntryLabel), { paused: pendingNow.filter(entry => entry.paused).length })
    if (queueLines.length > 0) {
      preEditorBlocks.push({
        lines: queueLines.map(text => ({ spans: [{ text, dim: true }] })),
        marginTop: 1,
      })
      // Queue already owns the blank line above the input unit.
      if (spinnerBlock) spinnerBlock = { ...spinnerBlock, marginTop: 0 }
    }
    // Update notice: sits on the same row as the spinner so a long wait
    // never grows an extra blank line above the composer. Staged is green
    // because it wants to be seen: "restart when convenient". Downloading
    // and manual-only-available are dim background noise. Failures stay
    // silent; the manual /update reports them with full context.
    let updateNotice = updateNoticeSpans({
      status: st.updateStatus,
      version: st.updateVersion,
      availableVersion: st.updateAvailable?.version ?? null,
      visible: st.overlay.kind === 'none' && !commandWindowIsMounted,
      busy: spinnerBlock !== null,
    })
    if (spinnerBlock && updateNotice) {
      spinnerBlock = attachUpdateNotice(spinnerBlock, updateNotice, deps.renderer.termCols)
      updateNotice = null
    }
    if (spinnerBlock) preEditorBlocks.push(spinnerBlock)
    // The ad slot is an idle-time surface: hidden while a task is running
    // (spinner visible) so it never competes with live output.
    if (adSlotTick.content && !st.isLoading && !spinnerBlock && !commandWindowIsMounted) {
      preEditorBlocks.push(...buildAdSlotBlocks(st.adSlot, adSlotTick, deps.renderer.termCols, adSlotNow))
    }
    if (updateNotice) {
      preEditorBlocks.push(standaloneUpdateNotice(updateNotice, deps.renderer.termCols, preEditorBlocks.length > 0))
    }

    const frame = buildShellFrame({
      contentLines,
      committedRows: st.historyRowCount,
      preEditorBlocks,
      prompt: getPromptVM(),
      overlay: st.overlay,
      commandFocused: st.focusedCommandWindowGeneration !== null,
      preview: st.commandWindowPreview,
    })
    st.selectorPreviewViewport = frame.previewViewport
    return frame
  }

  return { buildFrame, refreshBannerData, resetHistoryCache }
}
