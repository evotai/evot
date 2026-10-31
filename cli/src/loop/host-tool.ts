import {
  ASK_USER_SPEC,
  errorResponse,
  textResponse,
  type HostToolCall,
  type HostToolExtension,
  type HostToolResponse,
} from '../term/host-tools.js'
import type { LoopController } from './controller.js'
import { MIN_DELAY_SECONDS, MAX_DELAY_SECONDS } from './controller.js'
import { formatDuration } from './parser.js'
import { formatWallClock } from '../render/format.js'
import { earlyWakeSentence } from './early-wake.js'
import type { RunningBackgroundTask } from './prompt.js'
import { PLAN_STATES, formatPlanCounts, countPlan, parsePlanItems, planProgressSentence } from './plan.js'

export const LOOP_PLAN_SPEC = {
  name: 'loop_plan',
  label: 'Loop Plan',
  description: [
    'Record or update the checklist for the current /loop: what "done" means for this task. The host shows it to the user as a card and uses it to judge whether the loop may stop.',
    'Call it on the first pass before any other action, with every item the task implies, read broadly: include each kind of verification this conversation already established for this work (tests, benchmarks, result comparison, review, CI), not just the literal words of the task.',
    'Call it again whenever an item changes state or a new item appears (a review finding, a failure to fix). Always send the whole list, not a diff. Keep item text stable between calls so the host can tell what moved.',
    `States: ${PLAN_STATES.join(', ')}. blocked and deferred require a one-line note the user reads. Never drop an item; mark it deferred with the reason instead.`,
    'Do not repeat the checklist in your reply; the card already shows it. Your reply is one line: what this tick did and the cursor.',
  ].join(' '),
  parameters_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        description: 'The whole checklist, in order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', description: 'One line naming the item; keep it identical across calls.' },
            state: { type: 'string', enum: [...PLAN_STATES] },
            note: { type: 'string', description: 'One line for the user. Required when state is blocked or deferred.' },
          },
          required: ['text', 'state'],
        },
      },
    },
    required: ['items'],
  },
  name_aliases: [['claude', 'LoopPlan']],
}

export const SCHEDULE_WAKEUP_SPEC = {
  name: 'schedule_wakeup',
  label: 'Schedule Wakeup',
  description: [
    'Schedule when the current /loop resumes, or stop it. Write your status line first, then call this exactly once as the final action of the turn; the turn ends when it returns.',
    'When a background shell exits you are re-invoked automatically, so the delay is only a fallback in case it hangs. Use 270s (5 minutes; 300s exactly is snapped down to stay on the warm prompt cache) every time, for long waits too (a CI pipeline, a human review, a multi-hour run). Do not lengthen it on your own; only the user changes the pace.',
    'To end the loop, pass stop: true and omit the other fields; the loop stops immediately and does not fire again. Do this only when every loop_plan item is done or deferred with a visible note, or when the loop cannot move further without the user. If an item is still todo or doing, keep working or keep waiting instead.',
    'noop is required unless stop is true: true when you checked and nothing changed, false when you edited files, pushed, commented, advanced state, or surfaced a finding. Consecutive noop ticks are tracked as a streak and shown to you at the next wakeup, so a long quiet wait stays legible without re-reading the transcript.',
    'reason is required: one specific sentence ("watching CI run 39", not "waiting"). It is shown to the user.',
    'In a turn the user started while the loop is parked, call this only when they ask to change the pace or stop; otherwise leave the schedule alone.',
  ].join(' '),
  parameters_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      delay_seconds: {
        type: 'integer',
        minimum: MIN_DELAY_SECONDS,
        maximum: MAX_DELAY_SECONDS,
        description: `Seconds until the next wakeup (${MIN_DELAY_SECONDS}-${MAX_DELAY_SECONDS}). Required unless stop is true.`,
      },
      reason: {
        type: 'string',
        description: 'One specific sentence: what you are waiting for and why this delay.',
      },
      noop: {
        type: 'boolean',
        description: 'true when this turn checked and found nothing changed; false when it edited, pushed, commented, advanced state, or found something. Required unless stop is true.',
      },
      stop: {
        type: 'boolean',
        description: 'true to end the loop now.',
      },
    },
    required: ['reason'],
  },
  name_aliases: [['claude', 'ScheduleWakeup']],
  ends_turn: true,
}

export const LOOP_HOST_TOOL_SPECS_JSON = JSON.stringify([ASK_USER_SPEC, LOOP_PLAN_SPEC, SCHEDULE_WAKEUP_SPEC])

export function isScheduleWakeupName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === SCHEDULE_WAKEUP_SPEC.name || lower === 'schedulewakeup'
}

export function isLoopPlanName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === LOOP_PLAN_SPEC.name || lower === 'loopplan'
}

/** `backgroundTasks` is read at scheduling time so the result can tell the
 *  model and the user that a running shell cuts the wait short. */
export function createLoopExtension(
  controller: LoopController,
  backgroundTasks: () => readonly RunningBackgroundTask[] = () => [],
): HostToolExtension {
  return {
    specsJson: LOOP_HOST_TOOL_SPECS_JSON,
    handles: name => isScheduleWakeupName(name) || isLoopPlanName(name),
    dispatch: call => Promise.resolve(
      isLoopPlanName(call.tool_name)
        ? dispatchLoopPlan(call, controller)
        : dispatchScheduleWakeup(call, controller, backgroundTasks()),
    ),
  }
}

/** The result is JSON the card renders from: the host decided which items
 *  moved this tick, the model only sent the list. */
function dispatchLoopPlan(call: HostToolCall, controller: LoopController): HostToolResponse {
  if (!controller.active) return errorResponse(call, 'No loop is running.')
  const parsed = parsePlanItems(call.arguments.items)
  if ('error' in parsed) return errorResponse(call, parsed.error)
  const record = controller.setPlan(parsed.items)
  if (!record) return errorResponse(call, 'No loop is running.')
  return textResponse(call, JSON.stringify({ ...record, summary: formatPlanCounts(countPlan(record.items)) }))
}

function dispatchScheduleWakeup(
  call: HostToolCall,
  controller: LoopController,
  background: readonly RunningBackgroundTask[],
): HostToolResponse {
  if (!controller.active) return errorResponse(call, 'No loop is running.')
  const args = call.arguments
  const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
  if (args.stop === true) {
    controller.stop('model')
    return textResponse(call, `Loop stopped${reason ? `: ${reason}` : '.'}`)
  }
  const delay = typeof args.delay_seconds === 'number' ? args.delay_seconds : NaN
  if (!Number.isFinite(delay) || !reason) {
    return errorResponse(call, 'delay_seconds and reason are required when stop is not true.')
  }
  if (typeof args.noop !== 'boolean') {
    return errorResponse(call, 'noop is required when stop is not true: true if this turn changed nothing, false if it did.')
  }
  const applied = controller.schedule({ delaySeconds: delay, reason, noop: args.noop })
  const at = formatWallClock(Date.now() + applied * 1000)
  const clamped = applied !== Math.round(delay) ? ` (adjusted from ${Math.round(delay)}s)` : ''
  const progress = planProgressSentence(controller.snapshot?.plan ?? [])
  const progressText = progress ? ` ${progress}` : ''
  const early = earlyWakeSentence(background.map(task => task.taskId))
  const earlyText = early ? ` The loop ${early}.` : ''
  return textResponse(call, `Next wakeup in ${formatDuration(applied * 1000)} at ${at}${clamped}.${progressText}${earlyText}`)
}
