import type { ConfigInfo } from '../../../native/contracts/config-info.js'
import type { RemoteModels } from '../../../features/remote/protocol.js'
import { currentModelSpec, formatModelOptionLabel, modelAvailabilityLabel, modelGroupLabel, nextModelOption, sortModelOptionsForSelector } from '../../../features/models/options.js'

/** Project only picker metadata. The native config itself includes private
 * paths and endpoints that must never cross this transport. */
export function remoteModels(config: ConfigInfo | undefined, model: string, handoff: {spec: string; effort?: string} | null): RemoteModels {
  const active = currentModelSpec(config, model), effort = config?.thinkingLevel ?? ''
  const pending = handoff && { spec: handoff.spec, effort: handoff.effort }
  return { active, effort, pending, next: nextModelOption(config, model)?.spec, revision: JSON.stringify([active, effort, pending]),
    options: sortModelOptionsForSelector(config?.availableModels ?? [], active).map(option => ({
      spec: option.spec, label: formatModelOptionLabel(option), group: modelGroupLabel(option),
      levels: option.thinking_levels ?? [], warning: modelAvailabilityLabel(option),
    })) }
}
