export type ModelProtocol = 'anthropic' | 'openai' | 'openai_responses'

export interface ModelOption {
  provider: string
  protocol?: ModelProtocol
  model: string
  spec: string
  group_label?: string
  group_order?: number
  sort_order?: number
  /** Effort tiers this model actually supports, ascending. Absent when the
   *  model has no selectable reasoning, so absence means "no effort control". */
  thinking_levels?: string[]
  /** The tier this model starts on, always a member of `thinking_levels`. */
  thinking_level?: string
  free?: {
    display_name?: string
    tagline?: string
    is_new?: boolean
    tier?: string
  }
}

/** Published addon JSON. No version or fields are added by the decoder. */
export interface ConfigInfo {
  provider: string
  protocol: ModelProtocol
  envPath: string
  hasApiKey: boolean
  baseUrl: string | null
  availableModels: ModelOption[]
  thinkingLevel: string
  /** Retired field, decoded only for historical addon compatibility. */
  judge?: string
  /** The account's pinned landing model (cloud wire id), set with Space in the
   *  picker or by an admin. Absent when the account follows catalog rank. */
  defaultModel?: string
  /** Resolved user-level lifecycle executable. Absent from older addons. */
  sessionHook?: string
}

function invalid(path: string): never {
  // Never include the supplied value or raw JSON: config errors can contain secrets.
  throw new Error(`Invalid ConfigInfo at ${path}`)
}

function object(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path)
}

function field(value: unknown, type: 'string' | 'boolean' | 'number', path: string): void {
  if (typeof value !== type || (typeof value === 'number' && !Number.isFinite(value))) invalid(path)
}

function optional(record: Record<string, unknown>, key: string, type: 'string' | 'boolean' | 'number', path: string): void {
  if (record[key] !== undefined) field(record[key], type, `${path}.${key}`)
}

function protocol(value: unknown, path: string): void {
  if (value !== 'anthropic' && value !== 'openai' && value !== 'openai_responses') invalid(path)
}

function validateConfigInfo(value: unknown): asserts value is ConfigInfo {
  object(value, '$')
  for (const key of ['provider', 'envPath', 'thinkingLevel']) field(value[key], 'string', `$.${key}`)
  protocol(value.protocol, '$.protocol')
  field(value.hasApiKey, 'boolean', '$.hasApiKey')
  if (value.baseUrl !== null) field(value.baseUrl, 'string', '$.baseUrl')
  optional(value, 'judge', 'string', '$')
  optional(value, 'defaultModel', 'string', '$')
  optional(value, 'sessionHook', 'string', '$')
  if (!Array.isArray(value.availableModels)) invalid('$.availableModels')
  value.availableModels.forEach((entry: unknown, index: number) => {
    const path = `$.availableModels[${index}]`
    object(entry, path)
    for (const key of ['provider', 'model', 'spec']) field(entry[key], 'string', `${path}.${key}`)
    if (entry.protocol !== undefined) protocol(entry.protocol, `${path}.protocol`)
    optional(entry, 'group_label', 'string', path)
    optional(entry, 'group_order', 'number', path)
    optional(entry, 'sort_order', 'number', path)
    optional(entry, 'thinking_level', 'string', path)
    if (entry.thinking_levels !== undefined) {
      if (!Array.isArray(entry.thinking_levels)) invalid(`${path}.thinking_levels`)
      entry.thinking_levels.forEach((level: unknown, at: number) => {
        field(level, 'string', `${path}.thinking_levels[${at}]`)
      })
    }
    if (entry.free !== undefined) {
      object(entry.free, `${path}.free`)
      for (const key of ['display_name', 'tagline', 'tier']) optional(entry.free, key, 'string', `${path}.free`)
      optional(entry.free, 'is_new', 'boolean', `${path}.free`)
    }
  })
}

/** Decode at the transport boundary, not in views. Unknown fields are retained
 * for additive wire evolution; malformed known fields fail before reaching UI.
 * Absent optional model metadata remains absent (legacy payloads are not rewritten).
 */
export function decodeConfigInfo(json: string): ConfigInfo {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    invalid('$ (JSON)')
  }
  validateConfigInfo(value)
  return value
}
