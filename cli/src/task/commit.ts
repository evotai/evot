/** The one path a Task change takes to the cloud.
 *
 *  Whether the fields came from an agent tool call or from a shared link, the
 *  same things happen in the same order: delivery is made ready, the model is
 *  chosen in the visible picker, the merged result is confirmed, and only then
 *  is anything saved. Callers decide how to present the outcome; this module
 *  decides what the user is asked and what leaves the machine.
 */

import { parsePrivacyStop, type PrivacyStop } from '../privacy/notice.js'
import type { AskUserAnswer, AskUserParams } from '../term/host-tools.js'
import type { createTask, updateTask } from './client.js'
import {
  applySelection,
  pickerRequest,
  type TaskModelDefaults,
  type TaskModelPicker,
  type TaskModelPickerRequest,
} from './model-picker.js'
import type { TaskFlowState } from './prompt.js'
import { formatDiff } from '../render/diff.js'
import { BROADCAST_TARGET } from './types.js'

const DEFAULT_TIMEOUT_SECONDS = 900
const DEFAULT_MAX_LATENESS_SECONDS = 14_400

export interface TaskCommitContext {
  flow: TaskFlowState
  /** Resolved lazily so config/auth reads stay off the stream hot path. */
  defaults: () => Promise<TaskModelDefaults>
  pickModel: TaskModelPicker
  ensureDelivery?: () => Promise<boolean>
  collectAnswers: (params: AskUserParams) => Promise<AskUserAnswer[] | null>
  /** Transport seam. Absent: the native client, resolved on first save so
   *  importing this module never loads the addon. */
  persist?: TaskPersistence
  /** Privacy refused the definition: show the card. Absent hosts get the
   *  message alone. */
  privacyStopped?: (stop: PrivacyStop) => void
}

export interface TaskPersistence {
  create: typeof createTask
  update: typeof updateTask
}

async function nativePersistence(): Promise<TaskPersistence> {
  const client = await import('./client.js')
  return { create: client.createTask, update: client.updateTask }
}

export interface TaskCommitRequest {
  /** Fields as proposed. Model fields are always dropped; only the picker sets them. */
  arguments: Record<string, unknown>
  /** Where the picker opens, given the catalog just loaded. Absent: derived
   *  from `arguments.model` as a hint. */
  modelPreselect?: (defaults: TaskModelDefaults) => TaskModelPickerRequest
  /** Lines appended to the confirmation, e.g. where an import came from. */
  extraFields?: string[]
  /** Extra confirmation choices beyond Confirm / Cancel. Choosing one yields
   *  `{ kind: 'declined', choice }` so the caller can take another route. */
  extraOptions?: { label: string; description: string }[]
}

export type TaskCommitOutcome =
  | { kind: 'saved'; message: string; taskId?: string }
  /** The user stopped somewhere before saving. Nothing was sent. */
  | { kind: 'cancelled'; message: string }
  /** The user picked one of `extraOptions` at confirmation. Nothing was sent. */
  | { kind: 'declined'; choice: string }
  /** The user answered the confirmation in their own words instead of
   *  Confirm / Cancel: feedback on the proposed change. Nothing was sent
   *  and the flow stays open so a revised change can be proposed. */
  | { kind: 'revise'; feedback: string }
  /** The request reached the server and the outcome is unknown. */
  | { kind: 'failed'; message: string }
  /** Privacy refused it before anything was sent: known not saved. */
  | { kind: 'blocked'; message: string }

const EDITABLE = [
  'name', 'cron', 'timezone', 'instruction', 'model', 'thinking_level', 'workspace_ref',
  'delivery_channel', 'delivery_target', 'max_lateness_seconds', 'timeout_seconds',
]

function has(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key)
}

export function text(value: unknown): string {
  return String(value ?? '').trim()
}

/** Resolve where a task's result goes.
 *
 *  `feishu_ready` and `feishu_target` both come from device config via the
 *  addon, so this reads values rather than inventing a policy. "Not connected"
 *  and "connected but no default chat" are separate problems with separate
 *  fixes, and saying the wrong one sends the user to the wrong screen. */
function resolveDelivery(
  arguments_: Record<string, unknown>,
  flow: TaskFlowState,
  defaults?: TaskModelDefaults,
): Record<string, unknown> {
  const channel = text(arguments_.delivery_channel)
  const target = text(arguments_.delivery_target)
  const deviceTarget = text(defaults?.feishu_target)

  if (channel === 'feishu' || flow.mode === 'create') {
    if (channel && channel !== 'feishu') throw new Error(`Unsupported delivery channel: ${channel}`)
    const resolved = target || deviceTarget
    if (!resolved) {
      throw new Error(
        defaults?.feishu_ready
          ? 'Feishu is connected but has no default notification chat ID. Set one in settings, or give this task an explicit chat ID.'
          : 'Feishu is not connected on this device, so this task cannot deliver there. Connect it in settings, complete setup before creating the task.',
      )
    }
    return { delivery_channel: 'feishu', delivery_target: resolved }
  }
  if (has(arguments_, 'delivery_channel')) {
    if (channel) throw new Error(`Unsupported delivery channel: ${channel}`)
    return { delivery_channel: '', delivery_target: '' }
  }
  return {}
}

/** Strip everything the proposer may not decide, then resolve delivery.
 *
 *  Model fields are always dropped: on a model-choosing turn the picker writes
 *  them afterwards, and otherwise the stored task keeps its own model. */
export function normalizeTaskArguments(
  arguments_: Record<string, unknown>,
  flow: TaskFlowState,
  defaults?: TaskModelDefaults,
): Record<string, unknown> {
  const allowed = new Set(flow.mode === 'create' ? EDITABLE : [...EDITABLE, 'task_id', 'revision', 'enabled'])
  const patch = Object.fromEntries(Object.entries(arguments_).filter(([key]) => allowed.has(key)))
  if (flow.mode === 'update') {
    const current = flow.currentTask
    if (!current) throw new Error('No task is bound to this edit flow.')
    if ((has(arguments_, 'task_id') && arguments_.task_id !== current.id)
      || (has(arguments_, 'revision') && arguments_.revision !== current.revision)) {
      throw new Error('Task identity or revision does not match the confirmed edit flow.')
    }
    patch.task_id = current.id
    patch.revision = current.revision
  }
  delete patch.model
  delete patch.thinking_level
  return { ...patch, ...resolveDelivery(arguments_, flow, defaults) }
}

function modelLabel(spec: unknown, defaults?: TaskModelDefaults): string {
  const value = String(spec ?? '')
  const configured = defaults?.available_models?.find(model => model.spec === value)
  if (configured) return configured.label
  const model = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value
  return model || 'Unavailable model'
}

function modelSetting(
  policy: unknown,
  spec: unknown,
  thinkingLevel: unknown,
  defaults?: TaskModelDefaults,
): string {
  if (policy === 'default') return 'Device default at run time'
  const label = modelLabel(spec || defaults?.model_spec, defaults)
  const thinking = text(thinkingLevel || defaults?.thinking_level)
  return thinking ? `${label} · ${thinking}` : label
}

/** Name the destination concretely. A user confirming delivery should see the
 *  chat it lands in, not a vague "Feishu". */
function deliveryLabel(channel: unknown, target: unknown): string {
  if (channel !== 'feishu') return 'Local result only'
  const chat = text(target)
  if (chat === BROADCAST_TARGET) return 'Feishu · all bot direct conversations'
  return chat ? `Feishu · ${chat}` : 'Feishu · unavailable'
}

/** Same as `deliveryLabel`, but a new task that silently lands local-only says
 *  why. The user is approving a schedule they will not hear from otherwise. */
function createDeliveryLabel(
  patch: Record<string, unknown>,
  defaults?: TaskModelDefaults,
): string {
  if (patch.delivery_channel === 'feishu') {
    return deliveryLabel(patch.delivery_channel, patch.delivery_target)
  }
  if (!defaults?.feishu_ready) return 'Local result only · Feishu not connected'
  if (!text(defaults.feishu_target)) {
    return 'Local result only · no default Feishu notification chat'
  }
  return 'Local result only'
}

function createConfirmationFields(
  patch: Record<string, unknown>,
  defaults?: TaskModelDefaults,
): string[] {
  const fields: Record<string, unknown> = {
    name: patch.name,
    schedule: `${String(patch.cron ?? '')} · ${String(patch.timezone ?? '')}`,
    instruction: patch.instruction,
    model: modelSetting(patch.model_policy ?? 'fixed', patch.model_spec, patch.thinking_level, defaults),
    workspace_ref: patch.workspace_ref || 'Default workspace',
    delivery: createDeliveryLabel(patch, defaults),
    enabled: patch.enabled ?? true,
    timeout_seconds: patch.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
    max_lateness_seconds: patch.max_lateness_seconds ?? DEFAULT_MAX_LATENESS_SECONDS,
  }
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${String(value)}`)
}

/** Shown under every task confirmation: typing is not cancelling. */
export const REVISE_HINT = 'Not quite right? Type what to change and it will be revised before anything is saved.'

/** One field this request changes. */
interface FieldChange {
  label: string
  before: string
  after: string
}

/** The fields this request actually touches, so a confirmation never
 *  restates configuration the user did not ask to change. */
function taskUpdateChanges(
  patch: Record<string, unknown>,
  flow: TaskFlowState,
  defaults?: TaskModelDefaults,
): FieldChange[] {
  const current = flow.currentTask
  if (!current) return []
  const merged = { ...current, ...patch }
  const changes: FieldChange[] = []
  const touched = (...keys: string[]) => keys.some(key => has(patch, key))
  const add = (label: string, before: unknown, after: unknown) => {
    const left = String(before ?? '')
    const right = String(after ?? '')
    if (left !== right) changes.push({ label, before: left, after: right })
  }

  if (touched('name')) add('name', current.name, merged.name)
  if (touched('cron', 'timezone')) {
    add('schedule', `${current.cron} · ${current.timezone}`, `${merged.cron} · ${merged.timezone}`)
  }
  if (touched('instruction')) add('instruction', current.instruction, merged.instruction)
  if (touched('model_policy', 'model_spec', 'thinking_level')) {
    add(
      'model',
      modelSetting(current.model_policy, current.model_spec, current.thinking_level, defaults),
      modelSetting(merged.model_policy, merged.model_spec, merged.thinking_level, defaults),
    )
  }
  if (touched('workspace_ref')) {
    add(
      'workspace',
      current.workspace_ref || 'Default workspace',
      merged.workspace_ref || 'Default workspace',
    )
  }
  if (touched('delivery_channel', 'delivery_target')) {
    add(
      'delivery',
      deliveryLabel(current.delivery_channel, current.delivery_target),
      deliveryLabel(merged.delivery_channel, merged.delivery_target),
    )
  }
  if (touched('enabled')) {
    add('status', current.enabled ? 'Enabled' : 'Paused', merged.enabled ? 'Enabled' : 'Paused')
  }
  if (touched('timeout_seconds')) add('timeout', `${current.timeout_seconds}s`, `${merged.timeout_seconds}s`)
  if (touched('max_lateness_seconds')) {
    add('lateness', `${current.max_lateness_seconds}s`, `${merged.max_lateness_seconds}s`)
  }
  return changes
}

/** Confirmation lines. Scalar fields read `label: old → new`; the
 *  instruction, usually a paragraph, is shown once as a git-style diff (the
 *  same renderer as the Edit tool's output) instead of twice in full. */
function confirmationLines(changes: FieldChange[]): string[] {
  return changes.flatMap(change => {
    if (change.label === 'instruction') {
      // Instructions rarely end in a newline; give both a final one so the
      // patch has no "\ No newline at end of file" markers to show.
      const diff = formatDiff(withNewline(change.before), withNewline(change.after))
      return [
        `${change.label} (+${diff.linesAdded} −${diff.linesRemoved}):`,
        ...diff.text.split('\n'),
      ]
    }
    return [`${change.label}: ${change.before || '—'} → ${change.after || '—'}`]
  })
}

function withNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

/** One clause per field for the post-save sentence. */
function changeSummary(changes: FieldChange[]): string {
  return changes
    .map(change => change.label === 'instruction'
      ? 'instruction updated'
      : `${change.label}: ${change.before || '—'} → ${change.after || '—'}`)
    .join('; ')
}

/** Ready delivery, pick the model, confirm, save. Marks the flow as attempted
 *  the moment the user has seen a confirmation or a save has been tried, so a
 *  retry can never quietly duplicate a schedule. Throws only for programming
 *  or validation errors before anything was shown. */
export async function commitTaskChange(
  context: TaskCommitContext,
  request: TaskCommitRequest,
): Promise<TaskCommitOutcome> {
  const { flow } = context
  const creating = flow.mode === 'create'
  const arguments_ = request.arguments

  let defaults: TaskModelDefaults
  try {
    defaults = await context.defaults()
  } catch (error) {
    if (!context.ensureDelivery) throw error
    if (!(await context.ensureDelivery())) {
      flow.mutationAttempted = true
      flow.mutationError = 'delivery setup cancelled'
      return { kind: 'cancelled', message: 'Task change cancelled during setup. Nothing was submitted. Do not retry automatically.' }
    }
    defaults = await context.defaults()
  }
  const needsDelivery = creating || arguments_.delivery_channel === 'feishu'
  if (needsDelivery && (!defaults.feishu_ready
    || !(text(arguments_.delivery_target) || text(defaults.feishu_target)))) {
    if (!context.ensureDelivery) throw new Error('Feishu setup is required before creating this task.')
    if (!(await context.ensureDelivery())) {
      flow.mutationAttempted = true
      flow.mutationError = 'delivery setup cancelled'
      return { kind: 'cancelled', message: 'Task creation cancelled during delivery setup. Nothing was created. Do not retry automatically.' }
    }
    defaults = await context.defaults()
    if (!defaults.feishu_ready) throw new Error('Feishu setup is not complete. Nothing was created.')
  }
  let patch = normalizeTaskArguments(arguments_, flow, defaults)
  let effective = defaults
  // Creating always chooses a model. Editing does only when the request
  // mentioned one, so an unrelated edit never reopens the picker.
  const choosesModel = creating || has(arguments_, 'model') || has(arguments_, 'thinking_level')
  if (choosesModel) {
    const opening = request.modelPreselect
      ? request.modelPreselect(defaults)
      : pickerRequest(flow, defaults, arguments_.model)
    const selection = await context.pickModel(opening)
    if (!selection) {
      flow.mutationAttempted = true
      flow.mutationError = 'model selection cancelled by user'
      return { kind: 'cancelled', message: 'Task change cancelled during model selection. Do not retry unless asked.' }
    }
    const applied = applySelection(patch, selection, defaults)
    patch = applied.patch
    effective = applied.taskModel ?? defaults
  }

  const changes = creating ? [] : taskUpdateChanges(patch, flow, effective)
  const fields = [
    ...(creating ? createConfirmationFields(patch, effective) : confirmationLines(changes)),
    ...(request.extraFields ?? []),
  ]
  const answers = await context.collectAnswers({
    questions: [{
      header: 'Task',
      // The last line invites the reply that reopens the change (see
      // `revise`): the same words wherever a task change is confirmed.
      question: [
        creating
          ? 'Create this scheduled task?'
          : `Apply these changes to “${flow.currentTask?.name ?? 'Task'}”?`,
        ...(fields.length > 0 ? fields : creating ? [] : ['No effective changes']),
        '',
        REVISE_HINT,
      ].join('\n'),
      options: [
        {
          label: 'Confirm',
          description: `${creating ? 'Create' : 'Update'} the task with these settings.`,
        },
        ...(request.extraOptions ?? []),
        { label: 'Cancel', description: 'Keep the current task configuration.' },
      ],
    }],
  })
  const answer = answers?.[0]?.answer
  if (answer !== 'Confirm') {
    const declined = request.extraOptions?.find(option => option.label === answer)
    if (declined) {
      flow.mutationAttempted = true
      flow.mutationError = `declined: ${declined.label}`
      return { kind: 'declined', choice: declined.label }
    }
    // Typed text is a note on the proposal ("why so many lines?"), not a
    // refusal: hand it back so the change can be reworked and proposed again.
    const feedback = answer?.trim() ?? ''
    if (feedback && answer !== 'Cancel') {
      return { kind: 'revise', feedback }
    }
    flow.mutationAttempted = true
    flow.mutationError = 'cancelled by user'
    return { kind: 'cancelled', message: 'Task change cancelled by the user. Do not retry unless asked.' }
  }

  flow.mutationAttempted = true
  try {
    const persist = context.persist ?? await nativePersistence()
    if (creating) {
      const created = await persist.create(
        { ...patch, idempotency_key: flow.requestId ??= crypto.randomUUID() },
        effective.env_file,
      )
      const next = created.next_runs[0] ? new Date(created.next_runs[0]).toLocaleString() : 'paused'
      return { kind: 'saved', message: `Created ${created.task.name}. Next run: ${next}.`, taskId: created.task.id }
    }
    const { task_id, ...body } = patch
    const updated = await persist.update(String(task_id), body, effective.env_file)
    return {
      kind: 'saved',
      taskId: updated.task.id,
      message: changes.length > 0
        ? `Updated ${updated.task.name}: ${changeSummary(changes)}.`
        : `Updated ${updated.task.name}: no effective changes.`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    flow.mutationError = message
    const stop = parsePrivacyStop(message)
    if (stop) {
      context.privacyStopped?.(stop)
      return { kind: 'blocked', message: `Not saved: ${message}` }
    }
    return { kind: 'failed', message }
  }
}
