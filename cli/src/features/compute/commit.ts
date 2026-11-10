/** The one path a Compute change takes to `compute.json`.
 *
 *  The agent proposes; the host decides. The machine profile comes from the
 *  host's own probe in this flow, never from tool arguments, and nothing is
 *  saved until the user confirms the merged result.
 */

import type { AskUserAnswer, AskUserParams } from '../host-tools.js'
import { formatDiff } from '../../render/diff.js'
import { REVISE_HINT } from '../task/commit.js'
import { machineLabel, toolsLabel } from './format.js'
import type { ComputeFlowState } from './prompt.js'
import type { ComputeMachine, MachinePatch, NewMachine } from './types.js'

const MAX_DESCRIPTION_CHARS = 300

export interface ComputePersistence {
  create: (input: NewMachine) => Promise<ComputeMachine>
  update: (id: string, patch: MachinePatch) => Promise<ComputeMachine>
}

export interface ComputeCommitContext {
  flow: ComputeFlowState
  collectAnswers: (params: AskUserParams) => Promise<AskUserAnswer[] | null>
  persist: ComputePersistence
  /** Names already taken, read when the change is proposed. */
  existingNames: () => string[]
}

export type ComputeCommitOutcome =
  | { kind: 'saved'; message: string; machineId: string }
  | { kind: 'cancelled'; message: string }
  /** The user answered the confirmation in their own words instead. */
  | { kind: 'revise'; feedback: string }
  /** Arguments the agent must fix; nothing was shown or saved. */
  | { kind: 'invalid'; message: string }
  /** Saving failed after confirmation; nothing was written. */
  | { kind: 'failed'; message: string }

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function has(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined && source[key] !== null
}

function checkCommon(args: { name?: string; description?: string }, flow: ComputeFlowState, taken: string[]): string | null {
  if (args.name !== undefined) {
    if (!args.name) return 'name is required'
    const own = flow.currentMachine?.name.toLowerCase()
    if (args.name.toLowerCase() !== own && taken.some(name => name.toLowerCase() === args.name?.toLowerCase())) {
      return `a machine named ${args.name} already exists; choose another name`
    }
  }
  if (args.description !== undefined) {
    if (!args.description) return 'description is required: say what this machine should be used for'
    if ([...args.description].length > MAX_DESCRIPTION_CHARS) {
      return `description must be at most ${MAX_DESCRIPTION_CHARS} characters`
    }
  }
  return null
}

function withNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`
}

interface FieldChange { label: string; before: string; after: string }

/** Same shape as Task confirmations: `label: old → new`, and the long text
 *  field as a diff. */
function changeLines(changes: FieldChange[]): string[] {
  return changes.flatMap(change => {
    if (change.label === 'use for') {
      const diff = formatDiff(withNewline(change.before), withNewline(change.after))
      return [`${change.label} (+${diff.linesAdded} −${diff.linesRemoved}):`, ...diff.text.split('\n')]
    }
    return [`${change.label}: ${change.before || '—'} → ${change.after || '—'}`]
  })
}

function changeSummary(changes: FieldChange[]): string {
  return changes
    .map(change => change.label === 'use for' ? 'use for updated' : `${change.label}: ${change.before || '—'} → ${change.after || '—'}`)
    .join('; ')
}

async function confirm(
  context: ComputeCommitContext,
  question: string,
  fields: string[],
  confirmDescription: string,
  cancelDescription: string,
): Promise<{ confirmed: true } | ComputeCommitOutcome> {
  const answers = await context.collectAnswers({
    questions: [{
      header: 'Compute',
      question: [question, ...fields, '', REVISE_HINT].join('\n'),
      options: [
        { label: 'Confirm', description: confirmDescription },
        { label: 'Cancel', description: cancelDescription },
      ],
    }],
  })
  const answer = answers?.[0]?.answer
  if (answer === 'Confirm') return { confirmed: true }
  const feedback = answer?.trim() ?? ''
  if (feedback && answer !== 'Cancel') return { kind: 'revise', feedback }
  context.flow.mutationAttempted = true
  context.flow.mutationError = 'cancelled by user'
  return { kind: 'cancelled', message: 'Compute change cancelled by the user. Nothing was saved. Do not retry unless asked.' }
}

export async function commitComputeCreate(
  context: ComputeCommitContext,
  args: Record<string, unknown>,
): Promise<ComputeCommitOutcome> {
  const { flow } = context
  const input: NewMachine = {
    name: text(args.name),
    ssh_target: text(args.ssh_target),
    description: text(args.description),
  }
  if (!input.ssh_target) return { kind: 'invalid', message: 'ssh_target is required.' }
  const problem = checkCommon(input, flow, context.existingNames())
  if (problem) return { kind: 'invalid', message: `Not saved: ${problem}.` }
  const probe = flow.probes.get(input.ssh_target)
  if (!probe) {
    return { kind: 'invalid', message: `Check ${input.ssh_target} with compute_probe before adding it.` }
  }
  if (probe.check.status !== 'ok') {
    return {
      kind: 'invalid',
      message: `${input.ssh_target} did not pass its check (${probe.check.message || probe.check.status}). Tell the user and offer a retry or another machine; do not add it.`,
    }
  }
  const fields = [
    `name: ${input.name}`,
    probe.ssh_alias || input.ssh_target === input.name
      ? `ssh: ${input.ssh_target}`
      : `ssh: ${input.name} (new alias in ~/.ssh/config for ${input.ssh_target})`,
    `machine: ${machineLabel(probe.profile)}`,
    `tools: ${toolsLabel(probe.profile)}`,
    `use for: ${input.description}`,
  ]
  const decision = await confirm(context, 'Add this machine?', fields,
    'Add the machine with these settings.', 'Add nothing.')
  if (!('confirmed' in decision)) return decision

  flow.mutationAttempted = true
  try {
    const created = await context.persist.create({ ...input, profile: probe.profile, last_check: probe.check })
    return { kind: 'saved', message: `Added ${created.name}.`, machineId: created.id }
  } catch (error) {
    // Local writes are atomic: a failure saved nothing, so a fixed proposal
    // may be confirmed again.
    flow.mutationAttempted = false
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'failed', message }
  }
}

export async function commitComputeUpdate(
  context: ComputeCommitContext,
  args: Record<string, unknown>,
): Promise<ComputeCommitOutcome> {
  const { flow } = context
  const current = flow.currentMachine
  if (!current) return { kind: 'invalid', message: 'This edit has no machine.' }
  if (has(args, 'machine_id') && text(args.machine_id) !== current.id) {
    return { kind: 'invalid', message: 'machine_id does not match the machine being edited.' }
  }
  if (has(args, 'ssh_target') && text(args.ssh_target) !== current.ssh_target) {
    return { kind: 'invalid', message: 'The ssh target cannot be changed. Tell the user to add the other machine with /compute and delete this one.' }
  }
  const patch: MachinePatch = {}
  if (has(args, 'name')) patch.name = text(args.name)
  if (has(args, 'description')) patch.description = text(args.description)
  if (has(args, 'enabled')) patch.enabled = Boolean(args.enabled)
  const problem = checkCommon(patch, flow, context.existingNames())
  if (problem) return { kind: 'invalid', message: `Not saved: ${problem}.` }

  const changes: FieldChange[] = []
  const add = (label: string, before: string, after: string | undefined) => {
    if (after !== undefined && before !== after) changes.push({ label, before, after })
  }
  add('name', current.name, patch.name)
  add('use for', current.description, patch.description)
  add('status', current.enabled ? 'On' : 'Paused', patch.enabled === undefined ? undefined : patch.enabled ? 'On' : 'Paused')

  const decision = await confirm(context, `Apply these changes to “${current.name}”?`,
    changes.length ? changeLines(changes) : ['No effective changes'],
    'Update the machine with these settings.', 'Keep the current machine configuration.')
  if (!('confirmed' in decision)) return decision

  flow.mutationAttempted = true
  try {
    const updated = await context.persist.update(current.id, patch)
    return {
      kind: 'saved',
      machineId: updated.id,
      message: changes.length ? `Updated ${updated.name}: ${changeSummary(changes)}.` : `Updated ${updated.name}: no effective changes.`,
    }
  } catch (error) {
    flow.mutationAttempted = false
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'failed', message }
  }
}
