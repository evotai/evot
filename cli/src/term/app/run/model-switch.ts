import type { KnownRunEvent } from '../../../native/contracts/query-event.js'
import type { ModelSwitchOutcome, UIToolCall } from '../../../render/message-types.js'
import { modelSwitchTarget, successfulModelResponse, modelSwitchFailure } from '../../../render/model-switch.js'

export interface PendingModelSwitch {
  call: UIToolCall
  turn?: number
  failure?: ModelSwitchOutcome
}

export function observeModelSwitch(pending: PendingModelSwitch, event: KnownRunEvent): PendingModelSwitch | ModelSwitchOutcome {
  switch (event.kind) {
    case 'llm_call_started': {
      const { model, provider } = modelSwitchTarget(pending.call.args)
      return event.payload.model === model && (!event.payload.provider || event.payload.provider === provider)
        ? { call: pending.call, turn: event.payload.turn }
        : 'unconfirmed'
    }
    case 'assistant_delta':
      return pending.turn !== undefined && pending.turn === event.turn && event.payload.delta?.length ? 'started' : pending
    case 'assistant_tool_call':
      return pending.turn !== undefined && pending.turn === event.turn ? 'started' : pending
    case 'assistant_completed':
      return pending.turn !== undefined && pending.turn === event.turn
        && successfulModelResponse({ error: event.payload.error_message, stop_reason: event.payload.stop_reason })
        ? 'started' : pending
    case 'llm_call_completed': {
      if (pending.turn === undefined || pending.turn !== event.payload.turn) return pending
      if (successfulModelResponse(event.payload)) return 'started'
      return {
        ...pending,
        failure: modelSwitchFailure(event.payload),
      }
    }
    case 'error': return pending.failure ?? (pending.turn === undefined ? 'failed' : modelSwitchFailure({ error: event.payload.message }))
    case 'run_finished': return pending.failure ?? 'unconfirmed'
    default: return pending
  }
}
