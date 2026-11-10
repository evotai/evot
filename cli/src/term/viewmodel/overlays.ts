import type { OverlayState } from '../app/selector/overlay-state.js'
import type { ViewBlock } from './types.js'
import { buildAskBlocks } from './ask.js'
import { buildHelpBlocks } from './help.js'
import { buildSelectorBlocks } from './selector.js'

/** Composition only: each surface owns its presentation, never its siblings. */
export function buildOverlayBlocks(overlay: OverlayState, columns: number): ViewBlock[] {
  switch (overlay.kind) {
    case 'none': return []
    case 'help': return buildHelpBlocks(columns)
    case 'selector': return buildSelectorBlocks(overlay.state, columns)
    case 'ask-user': return buildAskBlocks(overlay.state, columns)
  }
}
