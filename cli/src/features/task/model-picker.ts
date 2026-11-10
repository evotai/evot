/** Task-scoped model picker: window construction plus the mapping between an
 *  agent's model hint, the visible catalog, and the user's final choice.
 *
 *  Ownership is separate from the live `/model` picker on purpose, so choosing a
 *  Task model never mutates the current chat model. */

import type { ConfigInfo } from '../../native/contracts/config-info.js'
import {
  selectorEffortLevel,
  selectorExpandItems,
  selectorFocusOn,
  type SelectorItem,
  type SelectorState,
} from '../../ui/selector.js'
import { createAppSelectorState } from '../../ui/selector-identity.js'
import { carryModelEfforts, currentModelSpec, modelOptions, modelSelectorItems } from '../models/options.js'
import type { TaskFlowState } from './prompt.js'
import { TASK_RUNTIME_DEFAULT_MODEL } from './types.js'

/** One row of the Task model catalog, as the confirmation view needs it. */
export interface TaskModelChoice {
  spec: string
  model: string
  label: string
  group?: string
  thinking_level: string
}

/** What the user picked. Catalog metadata is echoed back because a cloud sync
 *  may have refreshed the rows while the picker was open. */
export interface TaskModelSelection {
  spec: string
  thinkingLevel?: string
  model?: string
  label?: string
  group?: string
  defaultThinkingLevel?: string
}

export interface TaskModelPickerRequest {
  preferredSpec?: string
  preferredThinkingLevel?: string
  /** One line under the title, e.g. why the cursor is not where a shared
   *  task said it should be. */
  note?: string
}

export type TaskModelPicker = (
  request: TaskModelPickerRequest,
) => Promise<TaskModelSelection | null>

/** Model context available to a Task flow before the picker opens. */
export interface TaskModelDefaults {
  model_spec: string
  thinking_level: string
  available_models?: TaskModelChoice[]
  feishu_ready?: boolean
  feishu_target?: string
  env_file?: string
}

function taskModelItems(
  config: ConfigInfo | undefined,
  model: string,
  preferredSpec?: string,
  preferredThinkingLevel?: string,
): { items: SelectorItem[]; selectedSpec: string } {
  const models = modelOptions(config, model)
  const currentSpec = currentModelSpec(config, model)
  const selectedSpec = preferredSpec || currentSpec
  const selectedLevel = preferredThinkingLevel
    ?? (selectedSpec === currentSpec ? config?.thinkingLevel : undefined)
  const policyGroup = 'Policy'
  const missingTaskModel = selectedSpec !== TASK_RUNTIME_DEFAULT_MODEL
    && !models.some(option => option.spec === selectedSpec)
    ? [{
        id: selectedSpec,
        label: selectedSpec.includes(':') ? selectedSpec.slice(selectedSpec.indexOf(':') + 1) : selectedSpec,
        detail: '(currently unavailable)',
        group: 'Current task',
        selected: true,
        searchText: `${selectedSpec} current task unavailable`,
      } satisfies SelectorItem]
    : []
  return {
    selectedSpec,
    items: [
      { label: policyGroup, header: true, focusable: false, group: policyGroup },
      {
        id: TASK_RUNTIME_DEFAULT_MODEL,
        label: 'Device default at run time',
        detail: 'Follow this device when the task runs',
        group: policyGroup,
        selected: selectedSpec === TASK_RUNTIME_DEFAULT_MODEL,
        searchText: 'device default runtime follow',
      },
      ...(missingTaskModel.length > 0
        ? [{ label: 'Current task', header: true, focusable: false, group: 'Current task' } satisfies SelectorItem, ...missingTaskModel]
        : []),
      ...modelSelectorItems(models, selectedSpec, selectedLevel),
    ],
  }
}

export function createTaskModelWindow(
  config: ConfigInfo | undefined,
  model: string,
  preferredSpec?: string,
  preferredThinkingLevel?: string,
  note?: string,
): SelectorState {
  const { items, selectedSpec } = taskModelItems(config, model, preferredSpec, preferredThinkingLevel)
  return selectorFocusOn({
    ...createAppSelectorState('taskModel', 'Task model', items),
    subtitle: note ? `${note} · ←/→ thinking level` : 'Choose for this task · ←/→ thinking level',
    presentation: 'model',
    circularNavigation: true,
    listFocused: true,
  }, item => item.id === selectedSpec)
}

/** Replace the picker's catalog after cloud sync without losing interaction
 *  state. The selected marker records the preselected policy, while
 *  selectorExpandItems preserves the row under the user's cursor. */
export function refreshTaskModelWindow(
  state: SelectorState,
  config: ConfigInfo | undefined,
  model: string,
): SelectorState {
  const selected = state.allItems.find(item => item.selected && !item.header)
  const { items } = taskModelItems(config, model, selected?.id, selectorEffortLevel(selected))
  const refreshed = selectorExpandItems(state, carryModelEfforts(state.allItems, items))
  return { ...refreshed, subtitle: state.subtitle }
}

/** Compacted comparison key: case, spacing, and punctuation carry no meaning in
 *  a model name typed by a human or relayed by an agent. */
function key(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Best-effort match for an agent's model hint.
 *
 *  A hint only moves the picker's opening cursor, so an ambiguous or unknown
 *  hint returns undefined instead of failing: the catalog still opens, and the
 *  user's choice decides. */
export function matchModelHint(
  hint: string,
  models: TaskModelChoice[],
): TaskModelChoice | undefined {
  const query = key(hint)
  if (!query) return undefined
  const aliases = (model: TaskModelChoice) =>
    [model.label, model.model, model.group ? `${model.label} ${model.group}` : ''].filter(Boolean)
  const exact = models.filter(model => aliases(model).some(alias => key(alias) === query))
  const matches = exact.length > 0
    ? exact
    : models.filter(model => aliases(model).some(alias => {
        const candidate = key(alias)
        return candidate.includes(query) || query.includes(candidate)
      }))
  return matches.length === 1 ? matches[0] : undefined
}

/** Where the picker's cursor starts.
 *
 *  Editing always starts from the Task's persisted policy, never from a hint: a
 *  wrong hint must not cost the user a keystroke on the wrong row. When creating,
 *  a recognizable hint is a useful head start, and an unrecognizable one simply
 *  falls back to the live model. */
export function pickerRequest(
  flow: TaskFlowState,
  taskModel?: TaskModelDefaults,
  hint?: unknown,
): TaskModelPickerRequest {
  const current = flow.currentTask
  if (flow.mode === 'update' && current) {
    return current.model_policy === 'default'
      ? { preferredSpec: TASK_RUNTIME_DEFAULT_MODEL }
      : {
          preferredSpec: current.model_spec,
          preferredThinkingLevel: current.thinking_level,
        }
  }
  const hinted = typeof hint === 'string'
    ? matchModelHint(hint, taskModel?.available_models ?? [])
    : undefined
  if (hinted) {
    return { preferredSpec: hinted.spec, preferredThinkingLevel: hinted.thinking_level }
  }
  return {
    preferredSpec: taskModel?.model_spec,
    preferredThinkingLevel: taskModel?.thinking_level ?? '',
  }
}

function selectedModelChoice(
  selection: TaskModelSelection,
  taskModel?: TaskModelDefaults,
): TaskModelChoice | undefined {
  if (selection.model && selection.label) {
    return {
      spec: selection.spec,
      model: selection.model,
      label: selection.label,
      ...(selection.group ? { group: selection.group } : {}),
      thinking_level: selection.defaultThinkingLevel ?? '',
    }
  }
  return taskModel?.available_models?.find(item => item.spec === selection.spec)
}

/** Fold a confirmed picker choice into both the outgoing patch and the defaults
 *  used to render the confirmation, so no downstream label points at the live
 *  chat model captured before the picker opened. */
export function applySelection(
  patch: Record<string, unknown>,
  selection: TaskModelSelection,
  taskModel?: TaskModelDefaults,
): { patch: Record<string, unknown>; taskModel?: TaskModelDefaults } {
  const model = selectedModelChoice(selection, taskModel)
  const next = { ...patch }
  if (selection.spec === TASK_RUNTIME_DEFAULT_MODEL) {
    next.model_policy = 'default'
    delete next.model_spec
    delete next.thinking_level
    return { patch: next, taskModel }
  }
  if (!model) throw new Error('The selected Task model is no longer available.')
  next.model_policy = 'fixed'
  next.model_spec = model.spec
  next.thinking_level = selection.thinkingLevel ?? model.thinking_level
  return {
    patch: next,
    taskModel: {
      ...taskModel,
      model_spec: model.spec,
      thinking_level: selection.thinkingLevel ?? model.thinking_level,
      available_models: [
        ...(taskModel?.available_models ?? []).filter(item => item.spec !== model.spec),
        model,
      ],
    },
  }
}
