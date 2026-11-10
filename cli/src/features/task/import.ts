/** `/task <share-link>`: turn a shared task into one of the user's own.
 *
 *  A shared task is a recipe, and every part of it is already structured, so
 *  no agent turn is needed: the fields go straight into the same pipeline a
 *  confirmed tool call uses. What is never copied is anything about the
 *  publisher — delivery is resolved on this device, the model is chosen here
 *  from this catalog, with the shared choice only positioning the cursor.
 */

import type { TaskModelDefaults, TaskModelPickerRequest } from './model-picker.js'
import { TASK_RUNTIME_DEFAULT_MODEL, type TaskShareSnapshot } from './types.js'

export const ADJUST_WITH_AGENT = 'Adjust with agent'

/** The fields a snapshot contributes to a create request. Delivery is absent on
 *  purpose: `commitTaskChange` resolves it from device defaults, exactly as it
 *  does for a fresh `/task` request. */
export function importArguments(snapshot: TaskShareSnapshot): Record<string, unknown> {
  const data = snapshot.data
  return {
    name: data.name,
    cron: data.cron,
    timezone: data.timezone || 'UTC',
    instruction: data.instruction,
    timeout_seconds: data.timeout_seconds,
    max_lateness_seconds: data.max_lateness_seconds,
  }
}

/** Where the picker opens for an import.
 *
 *  The shared policy is honoured when this device can: "device default" is a
 *  policy and always applies; a fixed model applies when it is in the local
 *  catalog. A model this device does not have falls back to the live model —
 *  the picker is mandatory anyway, and `note` tells the user what the sharer
 *  used so the fallback is not mistaken for the recommendation. */
export function importModelPreselect(
  snapshot: TaskShareSnapshot,
  defaults: TaskModelDefaults,
): { request: TaskModelPickerRequest; note?: string } {
  const data = snapshot.data
  if (data.model_policy === 'default') {
    return { request: { preferredSpec: TASK_RUNTIME_DEFAULT_MODEL } }
  }
  const available = defaults.available_models?.some(model => model.spec === data.model_spec)
  if (data.model_spec && available) {
    return { request: { preferredSpec: data.model_spec, preferredThinkingLevel: data.thinking_level } }
  }
  const shared = data.model_spec.includes(':')
    ? data.model_spec.slice(data.model_spec.indexOf(':') + 1)
    : data.model_spec
  return {
    request: { preferredSpec: defaults.model_spec, preferredThinkingLevel: defaults.thinking_level },
    note: shared ? `Shared task used ${shared}; not available here` : undefined,
  }
}

/** The confirmation says where this came from, in the same key: value shape as
 *  the other fields. */
export function importExtraFields(snapshot: TaskShareSnapshot, link: string): string[] {
  const fields = [`source: ${link}`]
  if (snapshot.data.delivery_channel === 'feishu') {
    fields.push('shared delivery: masked, not imported — your own chat is used')
  }
  return fields
}

/** What the agent gets when the user wants to change something first: the
 *  recipe as a request, so the create prompt sees every field as already
 *  stated and asks only about the change. */
export function importAsRequest(snapshot: TaskShareSnapshot, link: string): string {
  const data = snapshot.data
  return [
    `Create a task from this shared definition (${link}). Treat every field below as already stated by the user; ask only what they want to change.`,
    `name: ${data.name}`,
    `cron: ${data.cron}`,
    `timezone: ${data.timezone || 'UTC'}`,
    `timeout_seconds: ${data.timeout_seconds}`,
    `max_lateness_seconds: ${data.max_lateness_seconds}`,
    'instruction:',
    data.instruction,
  ].join('\n')
}
