import type { OverlayState } from '../app/overlay-state.js'
import { isBackgroundSelector, isCommandSelector } from '../app/selector-identity.js'
import type { SelectorState } from '../selector.js'
import type { RenderFrame } from '../render-frame.js'
import type { PreviewViewport } from '../preview-scroll.js'
import { buildCommandSelectorRegion } from './command-selector.js'
import { buildAskRegionLines } from './ask.js'
import { buildSelectorRegionLines } from './selector.js'
import { buildOverlayBlocks } from './overlays.js'
import { buildPromptBlocks, type PromptVMInput } from './prompt.js'
import { buildPromptFooterBlocks } from './prompt-footer.js'
import { blocksToLines, type ViewBlock } from './types.js'
import { finiteSize } from './width.js'

export type CommandPreview = { kind: 'help' } | { kind: 'selector'; state: SelectorState }

export interface ShellSnapshot {
  contentLines: string[]
  /** Leading rows of `contentLines` that are append-only by index. */
  committedRows?: number
  preEditorBlocks: ViewBlock[]
  prompt: PromptVMInput
  overlay: OverlayState
  commandFocused: boolean
  preview: CommandPreview | null
}

export interface ShellFrame extends RenderFrame {
  /** In-memory layout feedback, shared with the selector's keyboard controller. */
  previewViewport?: PreviewViewport
}

/** Pure layout composition. The host owns snapshots, scheduling and lifecycle;
 * the renderer owns physical scrollback. The composer follows content in
 * normal flow, including after a formerly tall frame shrinks. Command
 * preview/focus swaps keep their geometry, but closing releases their rows. */
export function buildShellFrame(input: ShellSnapshot): ShellFrame {
  const { contentLines, prompt, overlay, preview } = input
  const preEditorLines = blocksToLines(input.preEditorBlocks)
  const base = {
    // Do not retain a historical bottom position: opening a command inserts
    // rows above the editor, and clearing it removes those same rows.
    bottomAnchor: false,
    ...(input.committedRows === undefined ? {} : { committedRows: input.committedRows }),
  }
  const commandFrame = (state: SelectorState, active: boolean): ShellFrame => {
    // The command window is already the completion surface. Measure the editor
    // first, without candidates, so a fixed selector slot cannot push status or
    // the caret into scrollback in a short tmux pane.
    const promptLines = blocksToLines(buildPromptBlocks({ ...prompt, completion: null }, {
      attachedAbove: true,
      reservedAboveRows: preEditorLines.length,
    }))
    // Keep a line of transcript context when present, including the sole row
    // of a fresh session: mounting a selector must not scroll that row away.
    const contextRows = contentLines.length > 0 ? 1 : 0
    const budget = Math.max(0, finiteSize(prompt.rows, 24) - preEditorLines.length - promptLines.length - contextRows)
    const selector = buildCommandSelectorRegion(state, prompt.columns, prompt.rows, active, budget)
    return {
      ...base,
      lines: contentLines.concat(preEditorLines, selector.lines, promptLines),
      transientRows: selector.lines.length,
      ...(selector.previewViewport ? { previewViewport: selector.previewViewport } : {}),
    }
  }
  if (overlay.kind === 'selector' && input.commandFocused && isCommandSelector(overlay.state)) {
    return commandFrame(overlay.state, true)
  }
  if (overlay.kind === 'none' && preview?.kind === 'selector') return commandFrame(preview.state, false)
  if (overlay.kind === 'selector' || overlay.kind === 'ask-user') {
    const surfaceLines = overlay.kind === 'selector'
      ? buildSelectorRegionLines(overlay.state, prompt.columns, prompt.rows)
      : buildAskRegionLines(overlay.state, prompt.columns)
    const footerPrompt = overlay.kind === 'selector' && isBackgroundSelector(overlay.state)
      ? { ...prompt, backgroundProcessCount: 0 }
      : { ...prompt, backgroundPanelDownAvailable: false }
    return {
      ...base,
      lines: contentLines.concat(preEditorLines, surfaceLines, blocksToLines(buildPromptFooterBlocks(footerPrompt))),
      transientRows: surfaceLines.length,
    }
  }
  const modalLines = blocksToLines(buildOverlayBlocks(overlay, prompt.columns))
  const previewLines = preview
    ? preview.kind === 'selector'
      ? buildCommandSelectorRegion(preview.state, prompt.columns, prompt.rows, false).lines
      : blocksToLines(buildOverlayBlocks({ kind: 'help' }, prompt.columns))
    : []
  const composer = preview ? { ...prompt, completion: null } : prompt
  const promptLines = blocksToLines(buildPromptBlocks(composer, {
    attachedAbove: preEditorLines.length > 0 || previewLines.length > 0,
    reservedAboveRows: preEditorLines.length + previewLines.length,
  }))
  return {
    ...base,
    lines: contentLines.concat(preEditorLines, previewLines, promptLines),
    transientRows: previewLines.length,
    ...(modalLines.length > 0 ? { overlay: { lines: modalLines } } : {}),
  }
}
