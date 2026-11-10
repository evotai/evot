import type { CompactRecord } from '../../../render/message-types.js'
import { toolArgsRecord } from '../../../session/tool-args.js'

/**
 * Project a `context_compaction_completed` result into the run's compact
 * history. The Rust writer emits `compacted` / `no_op` / `run_once_cleared`.
 * Field access is by narrowing, never by cast.
 */
export function compactRecordFromResult(result: unknown, currentContextTokens: number): CompactRecord | null {
  const fields = toolArgsRecord(result)
  const type = typeof fields?.type === 'string' ? fields.type : 'done'
  if (!fields) return null
  const first = (...names: string[]): number | undefined => {
    for (const name of names) {
      const value = fields[name]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
    return undefined
  }
  switch (type) {
    case 'compacted':
      return {
        beforeTokens: first('before_tokens') ?? 0,
        afterTokens: first('after_tokens') ?? 0,
      }
    case 'run_once_cleared':
      return {
        beforeTokens: first('before_estimated_tokens') ?? currentContextTokens,
        afterTokens: first('after_estimated_tokens') ?? (currentContextTokens - (first('saved_tokens') ?? 0)),
      }
    default:
      return null
  }
}
