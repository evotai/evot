import stripAnsi from 'strip-ansi'
import type { ModelSwitchOutcome, UIToolCall } from './message-types.js'
import { classifyProviderFailure } from './provider-error.js'

export const MODEL_SWITCH_TOOL = 'handoff_model'

export function modelSwitchText(text: string): string {
  return stripAnsi(text).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ').trim()
}

export function modelSwitchTarget(args: Record<string, unknown>): { provider?: string; model: string } {
  const spec = typeof args.model === 'string' ? args.model : ''
  const colon = spec.indexOf(':')
  return { provider: colon > 0 ? spec.slice(0, colon) : undefined, model: spec.slice(colon + 1) }
}

export function modelSwitchRoute(call: UIToolCall): string {
  const target = modelSwitchText(modelSwitchTarget(call.args).model)
  if (call.status !== 'done' || typeof call.args.model !== 'string' || !target) return target
  // The first line records the resolved switch; the remaining text is for the model.
  const route = call.result?.match(/^Model handoff: ([^\r\n]+)/)?.[1]
  const suffix = ` → ${call.args.model}`
  if (!route?.endsWith(suffix)) return target
  const source = route.slice(0, -suffix.length)
  const from = modelSwitchText(modelSwitchTarget({ model: source }).model)
  return from === target ? modelSwitchText(route) : `${from} → ${target}`
}

export function successfulModelResponse(result: { error?: unknown; stop_reason?: unknown }): boolean {
  return !result.error && !['error', 'aborted', 'refusal'].includes(String(result.stop_reason))
}

export function modelSwitchFailure(result: { error?: unknown; stop_reason?: unknown }): ModelSwitchOutcome {
  if (result.stop_reason === 'aborted') return 'interrupted'
  return typeof result.error === 'string' && classifyProviderFailure(result.error) === 'invalid-request'
    ? 'rejected' : 'failed'
}
