import type { ScheduledTask } from './types.js'
import { BROADCAST_TARGET } from './types.js'

export interface TaskPromptContext {
  localTimezone: string
  currentModel: string
  thinkingLevel: string
  availableModels: string[]
  savedModel?: string
}

export type TaskFlowMode = 'create' | 'update'

/** One /task mutation attempt. `mutationAttempted` makes the confirmed change
 *  single-shot: an agent must not silently retry a create or update. */
export interface TaskFlowState {
  mode: TaskFlowMode
  currentTask?: ScheduledTask
  mutationAttempted: boolean
  mutationError?: string
  requestId?: string
}

export function createTaskFlowState(
  mode: TaskFlowMode,
  currentTask?: ScheduledTask,
): TaskFlowState {
  return { mode, currentTask, mutationAttempted: false }
}

function modelContext(context: TaskPromptContext): string {
  return [
    `Current session model: ${context.currentModel || 'unavailable'}`,
    `Current thinking level: ${context.thinkingLevel || 'model default'}`,
    `Available model names: ${context.availableModels.join(', ') || 'none'}`,
  ].join('\n')
}

export function createTaskPrompt(
  request: string,
  context: TaskPromptContext,
): string {
  return [
    'Create a scheduled task from this request:',
    request,
    '',
    'Use the automation_task_create schema. Infer fields already stated by the user.',
    'When schedule, timezone, or instruction is missing or ambiguous, call ask_user and prefer one batched set of concise choices. Do not ask questions whose answers are already clear.',
    'Model selection is mandatory and belongs only to the host model picker. The host always opens the current model catalog before confirmation, even if the request names a model. Pass a named model only as a preselection hint; never use ask_user for model selection or invent an internal identifier.',
    'Do not ask where to deliver unless the user explicitly requests a different destination. New tasks require push delivery. The host guides Feishu setup when needed and uses the device\'s default notification chat. Never silently choose local-only delivery. Use a five-field cron expression and an IANA timezone.',
    'When the request is complete, call automation_task_create. The host resolves the model and shows the merged final configuration before saving.',
    'If the tool reports that the user replied with feedback instead of confirming, nothing was saved. Rework the change to address the feedback — schedule, instruction, model, delivery, whatever they objected to — and call the tool again so they see a fresh confirmation. Keep going until they confirm or cancel; ask a question only when the feedback is genuinely ambiguous. If they cancelled or declined, stop and do not retry unless asked.',
    '',
    `Local timezone: ${context.localTimezone}`,
    modelContext(context),
  ].join('\n')
}

export function updateTaskPrompt(
  task: ScheduledTask,
  context: TaskPromptContext,
): string {
  const model = task.model_policy === 'default'
    ? 'Device default at run time'
    : context.savedModel || 'Unavailable saved model'
  const delivery = task.delivery_channel === 'feishu'
    ? task.delivery_target === BROADCAST_TARGET
      ? 'All bot direct conversations'
      : 'Feishu chat'
    : 'Local result only'
  const editChoices = [
    { label: 'Schedule', description: `${task.cron} · ${task.timezone}` },
    { label: 'Instruction', description: task.instruction.replace(/\s+/g, ' ').slice(0, 80) },
    { label: 'Model', description: `${model}${task.thinking_level ? ` · ${task.thinking_level}` : ''}` },
    { label: 'Delivery', description: delivery },
  ]
  const current = {
    id: task.id,
    revision: task.revision,
    name: task.name,
    cron: task.cron,
    timezone: task.timezone,
    instruction: task.instruction,
    model: task.model_policy === 'default'
      ? 'Device default at run time'
      : context.savedModel || 'Unavailable saved model',
    thinking_level: task.thinking_level,
    workspace_ref: task.workspace_ref,
    delivery_channel: task.delivery_channel,
    delivery_target: task.delivery_target,
    timeout_seconds: task.timeout_seconds,
    max_lateness_seconds: task.max_lateness_seconds,
    enabled: task.enabled,
  }
  return [
    `Update scheduled task ${task.id} at revision ${task.revision}.`,
    `Current task: ${JSON.stringify(current)}`,
    '',
    'This flow was opened by pressing e in the Task list. The user has not chosen a field yet.',
    'First say one brief, user-visible sentence explaining that you will ask which field to edit. Then call ask_user in the same turn. Do not call automation_task_update before the user chooses a field.',
    `Use exactly this question: ${JSON.stringify({
      questions: [{
        header: 'Edit Task',
        question: `What do you want to change in “${task.name}”?`,
        options: editChoices,
      }],
    })}`,
    'The user replies in the composer; a plain-text reply stays in this edit. Never offer placeholder options such as "Type new value (use Other)" — an option that is not itself a concrete value is confusing.',
    'Instruction: if the user has not said what to change, ask in one short plain sentence what the task should do differently and end the turn. Once they describe a goal, a problem, or a complaint, do not merely analyse it — rewrite the full instruction yourself to address it, keep everything else from the current instruction, and call automation_task_update with the complete new instruction right away. The confirmation UI shows old → new and lets the user accept, refine, or cancel, so do not ask them to retype the whole instruction. If they only ask a question, answer briefly and propose the concrete rewrite in the same turn.',
    'Schedule: if no value was given, call ask_user with 3–4 concrete choices (each a real cron + timezone) plus Other for a custom time. Delivery: call ask_user with the real destination choices. Never ask for these in plain text.',
    'When you have the actual value, call automation_task_update with only that change.',
    'After the user chooses Model, briefly say that the model picker will open, then call automation_task_update with model set to "keep current"; the host will open the Task model picker, where the user makes the actual model choice.',
    'When model or thinking changes, the host model picker preselects the saved Task model. Never invent an internal model identifier.',
    'For other fields, once the user has supplied a new value, briefly state the intended change in ordinary assistant text before calling automation_task_update. The confirmation UI and the final reply report the result; do not narrate private reasoning or claim a save before the tool succeeds.',
    'Omitted fields keep their current values. The host confirms and reports only fields changed in this request as old → new. After success, reply with one concise sentence and never restate unchanged Task configuration.',
    'If the tool reports that the user replied with feedback instead of confirming, nothing was saved. Rework the change to address the feedback and call the tool again so they see a fresh confirmation. Keep going until they confirm or cancel; if feedback is ambiguous, ask one short clarifying question. If they cancelled or declined, stop and do not retry unless asked.',
    '',
    `Local timezone: ${context.localTimezone}`,
    modelContext(context),
  ].join('\n')
}
