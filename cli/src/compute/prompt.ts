import type { ComputeCandidate, ComputeMachine, ProbeResult } from './types.js'

export interface ComputePromptContext {
  /** This computer, e.g. `Apple M5 Pro · 15 CPUs · 24 GB`. */
  localMachine: string
  /** Basename of the current workspace. */
  project: string
  /** Names already in the Compute list. */
  existingNames: string[]
}

export type ComputeFlowMode = 'create' | 'update'

/** One /compute mutation attempt. `mutationAttempted` makes the confirmed
 *  change single-shot, as for /task. The host also remembers what the user
 *  typed and chose, so it can refuse to probe a machine nobody picked. */
export interface ComputeFlowState {
  mode: ComputeFlowMode
  currentMachine?: ComputeMachine
  mutationAttempted: boolean
  mutationError?: string
  /** The request and every ask_user answer in this flow. */
  userText: string[]
  candidates?: ComputeCandidate[]
  probes: Map<string, ProbeResult>
}

export function createComputeFlowState(
  mode: ComputeFlowMode,
  request = '',
  currentMachine?: ComputeMachine,
): ComputeFlowState {
  return {
    mode,
    currentMachine,
    mutationAttempted: false,
    userText: request.trim() ? [request.trim()] : [],
    probes: new Map(),
  }
}

function contextLines(context: ComputePromptContext): string[] {
  return [
    `This computer: ${context.localMachine}`,
    `Project: ${context.project}`,
    `Already added: ${context.existingNames.join(', ') || 'none'}`,
  ]
}

export function createComputePrompt(request: string, context: ComputePromptContext): string {
  return [
    'Add a compute machine: an ssh host the user lets evot use, for whatever the user says it is for.',
    `Request: ${request.trim() || '(none — find candidates)'}`,
    '',
    'Unless the request already names exactly one machine, call compute_discover first. It reads local files only and connects to nothing.',
    'Then call ask_user once with header "Compute" and question "Which machine should evot use?". Offer up to three candidates; each option label is the exact ssh target and its description is the discovery evidence. Put the best one first and append " (Recommended)" to its label. Prefer machines used often and recently. Never recommend one whose warning mentions a database or production. If discovery found nothing, ask with "options": [] for user@host or an ssh alias.',
    'Call compute_probe only for the machine the user chose. Never check any other machine. If the check fails, say why in one sentence, then call ask_user to offer a retry or another machine.',
    'After a successful check, call ask_user with header "Compute", question "What should evot use this machine for?" and "options": [], so the user types the use in their own words. Do not suggest uses. Their answer becomes the description; only tidy it up, never add uses they did not mention.',
    'Then call compute_create with name, ssh_target exactly as chosen, and description. For name use the ssh alias when the target is one; otherwise a short lowercase name for its role, such as build-1. A target that is not an alias yet is saved as a new Host alias with that name in ~/.ssh/config, so the address is never used again. The host shows the full configuration and asks the user to confirm before anything is saved.',
    'If the tool reports that the user replied with feedback instead of confirming, nothing was saved. Revise to address the feedback and call compute_create again so they see a fresh confirmation. If they cancelled, stop and do not retry unless asked.',
    'After success, reply with one short sentence. Do not restate the configuration.',
    '',
    ...contextLines(context),
  ].join('\n')
}

export function updateComputePrompt(machine: ComputeMachine, context: ComputePromptContext): string {
  const current = {
    id: machine.id,
    name: machine.name,
    ssh_target: machine.ssh_target,
    description: machine.description,
    enabled: machine.enabled,
  }
  const choices = [
    { label: 'Use for', description: machine.description.replace(/\s+/g, ' ').slice(0, 80) },
    { label: 'Name', description: machine.name },
  ]
  return [
    `Edit compute machine ${machine.id}.`,
    `Current machine: ${JSON.stringify(current)}`,
    '',
    'This flow was opened by pressing e in the Compute list. The user has not chosen a field yet.',
    'First say one brief, user-visible sentence explaining that you will ask which field to edit. Then call ask_user in the same turn. Do not call compute_update before the user chooses a field.',
    `Use exactly this question: ${JSON.stringify({
      questions: [{
        header: 'Edit Compute',
        question: `What do you want to change in “${machine.name}”?`,
        options: choices,
      }],
    })}`,
    'A plain-text reply in the composer stays in this edit. Never offer placeholder options; when you only need typed input, call ask_user with "options": [] so the UI opens a text field.',
    'Use for: if the user has not said what to change, call ask_user in the same turn with one free-text question ("options": []) asking what this machine should be used for. Once they say it, rewrite the full description yourself (at most 300 characters), keep what still applies, and call compute_update with it right away. The confirmation shows old → new.',
    'Name: ask with "options": [] or with concrete names, then call compute_update with only that change.',
    'The ssh target cannot be edited; to use another machine, add it with /compute and delete this one.',
    'Omitted fields keep their current values. After success, reply with one concise sentence.',
    'If the tool reports feedback instead of a confirmation, nothing was saved: revise and call compute_update again. If the user cancelled, stop and do not retry unless asked.',
    '',
    ...contextLines(context),
  ].join('\n')
}
