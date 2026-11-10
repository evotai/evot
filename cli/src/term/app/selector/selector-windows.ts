import type { ConfigInfo } from '../../../native/contracts/config-info.js'
import type { Hint } from '../../../ui/key-hints.js'
import {
  selectorFocusOn,
  type SelectorEffort,
  type SelectorItem,
  type SelectorState,
} from '../../../ui/selector.js'
import { createAppSelectorState } from '../../../ui/selector-identity.js'
import { currentModelSpec, modelOptions, modelSelectorItems } from '../../../features/models/options.js'
import { RESUME_SELECTOR_TITLE } from '../../../session/resume.js'
import { browseWindow } from '../../../ui/browse-window.js'

/** One factory for preview and explicitly opened model windows. */
/** Enter uses a model for this session; Space only saves the highlighted row
 *  as the account default (the picker stays open, the live model stays put). */
export const MODEL_WINDOW_HINTS: Hint[] = [
  { keys: ['up', 'down'], action: 'select' },
  { keys: 'enter', action: 'use' },
  { keys: 'space', action: 'set default' },
  { keys: 'type', action: 'search' },
  { keys: 'escape', action: 'close' },
]

export function createModelWindow(config: ConfigInfo | undefined, model: string, listFocused = false): SelectorState {
  const models = modelOptions(config, model)
  const activeSpec = currentModelSpec(config, model)
  return selectorFocusOn({
    ...createAppSelectorState('model', 'Models', modelSelectorItems(models, activeSpec, config?.thinkingLevel, config?.defaultModel)),
    presentation: 'model',
    circularNavigation: true,
    listFocused,
    hints: MODEL_WINDOW_HINTS,
  }, item => item.id === activeSpec)
}

/**
 * Resume list window.
 *
 * `listFocused` mirrors `createModelWindow`'s flag for the same reason: the
 * command preview is driven by the composer's text, while Enter/↑ opens a list
 * that owns its own letters. Only the focused list treats `e`/`d` as actions;
 * the preview keeps typing as search.
 */
export function createResumeWindow(
  items: SelectorItem[],
  initialQuery?: string,
  listFocused = false,
  detailPane = false,
): SelectorState {
  const state = createAppSelectorState('resume', RESUME_SELECTOR_TITLE, items, items, initialQuery)
  return {
    ...browseWindow(state, listFocused),
    // The `/share` list keeps its pane: the link it is opened for lives there.
    ...(detailPane ? {} : { rowLayout: 'session-line' as const }),
    ...(state.query.length === 0 && state.items.length === 0 && state.allItems.some(item => !item.header)
      ? { emptyMessage: listFocused
        ? 'No sessions in current cwd · press / to search all sessions'
        : 'No sessions in current cwd · type to search all sessions' }
      : {}),
  }
}
