/** Host-side handling of the `compute_*` tools.
 *
 *  Discovery and probing run here, not in the model: the model only sees
 *  their summaries, the profile it proposes is never trusted, and a probe is
 *  refused for any machine the user did not name or pick in this flow.
 */

import {
  ASK_USER_SPEC,
  dispatchHostToolCall,
  errorResponse,
  textResponse,
  type AskUserAnswer,
  type AskUserParams,
  type HostToolCall,
  type HostToolExtension,
  type HostToolResponse,
} from '../term/host-tools.js'
import { commitComputeCreate, commitComputeUpdate, type ComputeCommitContext, type ComputeCommitOutcome } from './commit.js'
import { candidateEvidence, checkStatusLabel, machineLabel, toolsLabel } from './format.js'
import type { ComputeFlowState } from './prompt.js'
import type { ComputeCandidate, ProbeResult } from './types.js'

const machineFields = {
  name: { type: 'string', description: 'Short name, letters, digits, - _ or . (max 32).' },
  description: { type: 'string', description: 'What evot should use this machine for (max 300 characters).' },
}

export const COMPUTE_DISCOVER_SPEC = {
  name: 'compute_discover',
  label: 'Find machines',
  description: 'List ssh machines this computer has used, from ssh config, shell history and Tailscale. Reads local files only; connects to nothing.',
  parameters_schema: { type: 'object', additionalProperties: false, properties: {} },
}

export const COMPUTE_PROBE_SPEC = {
  name: 'compute_probe',
  label: 'Check machine',
  description: 'Connect once over ssh, read-only, to the machine the user chose, and report its system, CPUs, memory and tools. Never call it for a machine the user did not choose.',
  parameters_schema: {
    type: 'object',
    additionalProperties: false,
    properties: { target: { type: 'string', description: 'The exact ssh target the user chose.' } },
    required: ['target'],
  },
}

export const COMPUTE_CREATE_SPEC = {
  name: 'compute_create',
  label: 'Add machine',
  description: 'Add a checked machine to Compute after the user confirms the final configuration.',
  parameters_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ssh_target: { type: 'string', description: 'The ssh target exactly as checked.' },
      ...machineFields,
    },
    required: ['name', 'ssh_target', 'description'],
  },
}

export const COMPUTE_UPDATE_SPEC = {
  name: 'compute_update',
  label: 'Update machine',
  description: 'Change a Compute machine after the user confirms. Send only the fields that change.',
  parameters_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      machine_id: { type: 'string' },
      ...machineFields,
    },
    required: ['machine_id'],
  },
}

const CREATE_TOOLS = [ASK_USER_SPEC, COMPUTE_DISCOVER_SPEC, COMPUTE_PROBE_SPEC, COMPUTE_CREATE_SPEC]
const UPDATE_TOOLS = [ASK_USER_SPEC, COMPUTE_UPDATE_SPEC]

export interface ComputeToolContext extends ComputeCommitContext {
  discover: () => Promise<ComputeCandidate[]>
  probe: (target: string) => Promise<ProbeResult>
}

function candidatesText(candidates: ComputeCandidate[]): string {
  if (candidates.length === 0) {
    return 'No candidates found in ssh config, shell history or Tailscale. Ask the user for user@host or an ssh alias.'
  }
  return [
    'Candidates, best first (target — evidence):',
    ...candidates.map(candidate => `- ${candidate.target} — ${candidateEvidence(candidate)}`),
  ].join('\n')
}

function probeText(result: ProbeResult): string {
  if (result.check.status !== 'ok') {
    return `Check failed for ${result.target}: ${checkStatusLabel(result.check.status)}. ${result.check.message}`.trim()
  }
  return [
    `${result.target} is reachable.`,
    `Machine: ${machineLabel(result.profile) || 'unknown'}${result.profile?.arch ? ` · ${result.profile.arch}` : ''}`,
    `Tools: ${toolsLabel(result.profile)}`,
  ].join('\n')
}

/** True when the user named this target, as a whole word, in the request or
 *  in an answer. */
function userChose(flow: ComputeFlowState, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const edge = '[^A-Za-z0-9@._:%\\[\\]-]'
  const word = new RegExp(`(?:^|${edge})${escaped}(?:$|${edge}|\\.(?:$|\\s))`, 'i')
  return flow.userText.some(line => word.test(line))
}

function outcomeResponse(call: HostToolCall, outcome: ComputeCommitOutcome): HostToolResponse {
  switch (outcome.kind) {
    case 'saved':
    case 'cancelled':
      return textResponse(call, outcome.message)
    case 'invalid':
      return errorResponse(call, outcome.message)
    case 'revise':
      return textResponse(
        call,
        `The user did not confirm the change and replied: "${outcome.feedback}"\n`
        + `Nothing was saved. Revise the proposal to address this feedback, then call ${call.tool_name} again with the full updated arguments. `
        + 'If the feedback is unclear, ask the user before proposing again.',
      )
    case 'failed':
      return errorResponse(call, `Not saved: ${outcome.message}. Nothing was written; fix the problem and call ${call.tool_name} again.`)
  }
}

export function createComputeExtension(context: ComputeToolContext): HostToolExtension {
  const { flow } = context
  const tools = flow.mode === 'create' ? CREATE_TOOLS : UPDATE_TOOLS
  const names = new Set(tools.map(tool => tool.name))
  return {
    specsJson: JSON.stringify(tools),
    // ask_user is claimed too, so the flow learns what the user picked.
    handles: name => names.has(name) || /^askuser$/i.test(name),
    dispatch: call => dispatchComputeToolCall(call, context),
  }
}

async function dispatchComputeToolCall(call: HostToolCall, context: ComputeToolContext): Promise<HostToolResponse> {
  const { flow } = context
  if (call.tool_name === ASK_USER_SPEC.name || /^askuser$/i.test(call.tool_name)) {
    const collect = async (params: AskUserParams): Promise<AskUserAnswer[] | null> => {
      const answers = await context.collectAnswers(params)
      for (const answer of answers ?? []) flow.userText.push(answer.answer)
      return answers
    }
    return dispatchHostToolCall({ ...call, tool_name: ASK_USER_SPEC.name }, collect)
  }
  if (flow.mutationAttempted) {
    const detail = flow.mutationError ? `: ${flow.mutationError}` : ''
    return textResponse(call, `This Compute flow already made its confirmed change${detail}. Do not retry; ask the user to start a new /compute action.`)
  }
  try {
    switch (call.tool_name) {
      case COMPUTE_DISCOVER_SPEC.name: {
        if (flow.mode !== 'create') return errorResponse(call, 'Discovery is only available while adding a machine.')
        flow.candidates ??= await context.discover()
        return textResponse(call, candidatesText(flow.candidates))
      }
      case COMPUTE_PROBE_SPEC.name: {
        if (flow.mode !== 'create') return errorResponse(call, 'Checking is only available while adding a machine.')
        const target = typeof call.arguments.target === 'string' ? call.arguments.target.trim() : ''
        if (!target) return errorResponse(call, 'target is required.')
        if (!userChose(flow, target)) {
          return errorResponse(call, `The user has not chosen ${target}. Ask them with ask_user first; never check a machine they did not pick.`)
        }
        const result = await context.probe(target)
        flow.probes.set(target, result)
        return textResponse(call, probeText(result))
      }
      case COMPUTE_CREATE_SPEC.name:
        if (flow.mode !== 'create') return errorResponse(call, 'This Compute flow only allows update.')
        return outcomeResponse(call, await commitComputeCreate(context, call.arguments))
      case COMPUTE_UPDATE_SPEC.name:
        if (flow.mode !== 'update') return errorResponse(call, 'This Compute flow only allows create.')
        return outcomeResponse(call, await commitComputeUpdate(context, call.arguments))
      default:
        return errorResponse(call, `Unknown host tool: ${call.tool_name}`)
    }
  } catch (error) {
    return errorResponse(call, `${error instanceof Error ? error.message : String(error)}`)
  }
}
