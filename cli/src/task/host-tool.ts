/** Host-side handling of the `automation_task_*` tools.
 *
 *  The agent proposes; the host decides. Two things are never taken from tool
 *  arguments: the model (only the visible picker sets it) and the delivery
 *  target (only device config sets it). Everything else is confirmed by the user
 *  before it reaches the cloud. The pipeline that does so is `commit.ts`,
 *  shared with `/task <share-link>`; this file owns the tool schema and the
 *  tool-response wording.
 */

import {
  ASK_USER_SPEC,
  errorResponse,
  textResponse,
  type HostToolCall,
  type HostToolExtension,
  type HostToolResponse,
} from '../term/host-tools.js'
import { commitTaskChange, type TaskCommitContext } from './commit.js'
import { BROADCAST_TARGET } from './types.js'

const MIN_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 3600

const properties = {
  name: { type: 'string' },
  cron: { type: 'string', description: 'Five-field cron expression.' },
  timezone: { type: 'string', description: 'IANA timezone.' },
  instruction: { type: 'string' },
  model: {
    type: 'string',
    description: 'Optional human model name used only to preselect the host model picker. The user makes the final choice from the current model catalog.',
  },
  thinking_level: {
    type: 'string',
    enum: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    description: 'Optional preferred thinking level. The user makes the final choice in the host model picker.',
  },
  workspace_ref: { type: 'string' },
  delivery_channel: { type: 'string', enum: ['', 'feishu'] },
  delivery_target: {
    type: 'string',
    description: `Optional explicit Feishu chat ID. Usually omit it: the host uses the device's default notification chat. Use "${BROADCAST_TARGET}" only when the user explicitly asks to notify every 1:1 conversation the bot knows.`,
  },
  max_lateness_seconds: { type: 'integer', minimum: 0 },
  timeout_seconds: {
    type: 'integer',
    minimum: MIN_TIMEOUT_SECONDS,
    maximum: MAX_TIMEOUT_SECONDS,
    description: `Run timeout in seconds (${MIN_TIMEOUT_SECONDS}-${MAX_TIMEOUT_SECONDS}). Values outside this range are clamped by the runner.`,
  },
}

export const TASK_CREATE_SPEC = {
  name: 'automation_task_create',
  label: 'Create Task',
  description: "Create a recurring task with push delivery after final confirmation. The host guides Feishu setup when needed; never silently choose local-only delivery.",
  parameters_schema: {
    type: 'object',
    additionalProperties: false,
    properties,
    required: ['name', 'cron', 'timezone', 'instruction'],
  },
}

export const TASK_UPDATE_SPEC = {
  name: 'automation_task_update',
  label: 'Update Task',
  description: 'Update a recurring task after the user has confirmed the changes.',
  parameters_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      task_id: { type: 'string' },
      revision: { type: 'integer' },
      ...properties,
      enabled: { type: 'boolean' },
    },
    required: ['task_id', 'revision'],
  },
}

export const TASK_HOST_TOOL_SPECS_JSON = JSON.stringify([
  ASK_USER_SPEC,
  TASK_CREATE_SPEC,
  TASK_UPDATE_SPEC,
])

export type TaskToolContext = TaskCommitContext

/** Kept as the tool's public surface; the pipeline itself lives in `commit.ts`. */
export { normalizeTaskArguments } from './commit.js'

/** Register the task tools with the generic host-tool dispatcher. */
export function createTaskExtension(context: TaskToolContext): HostToolExtension {
  return {
    specsJson: TASK_HOST_TOOL_SPECS_JSON,
    handles: name => name === TASK_CREATE_SPEC.name || name === TASK_UPDATE_SPEC.name,
    dispatch: call => dispatchTaskToolCall(call, context),
  }
}

async function dispatchTaskToolCall(
  call: HostToolCall,
  context: TaskToolContext,
): Promise<HostToolResponse> {
  const { flow } = context
  try {
    const creating = call.tool_name === TASK_CREATE_SPEC.name
    if ((creating ? 'create' : 'update') !== flow.mode) {
      return errorResponse(call, `This Task flow only allows ${flow.mode}.`)
    }
    // One confirmed mutation per flow. Retrying a create the user already saw
    // would silently duplicate a schedule.
    if (flow.mutationAttempted) {
      const detail = flow.mutationError ? `: ${flow.mutationError}` : ''
      return textResponse(
        call,
        `This Task flow already attempted its confirmed change${detail}. Do not retry automatically; ask the user to start a new /task action.`,
      )
    }
    const outcome = await commitTaskChange(context, { arguments: call.arguments })
    switch (outcome.kind) {
      case 'saved':
      case 'cancelled':
        return textResponse(call, outcome.message)
      case 'blocked':
        return errorResponse(
          call,
          `${outcome.message} Tell the user to keep secrets in the task's env file and name the variable in the instruction; do not retry with the value.`,
        )
      case 'declined':
        return textResponse(call, 'Task change declined by the user. Do not retry unless asked.')
      case 'revise':
        return textResponse(
          call,
          `The user did not confirm the change and replied: "${outcome.feedback}"\n`
          + 'Nothing was saved. Revise the proposal to address this feedback, then call '
          + `${call.tool_name} again with the full updated arguments (same task_id and revision). `
          + 'If the feedback is unclear, ask the user before proposing again.',
        )
      case 'failed':
        return errorResponse(
          call,
          `${outcome.message}. The save outcome is unknown. Check /task before starting another change; do not retry automatically.`,
        )
    }
  } catch (error) {
    flow.mutationAttempted = true
    flow.mutationError = error instanceof Error ? error.message : String(error)
    return errorResponse(call, `${flow.mutationError} Do not retry automatically.`)
  }
}
