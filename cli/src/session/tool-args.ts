import { parse as partialParse } from 'partial-json'

/** Parse an in-progress tool-call JSON object, matching pi's partial-json path. */
export function parseStreamingToolArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    try {
      const parsed = partialParse(raw)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
}

/** Wire tool arguments are arbitrary JSON; the UI only displays object fields. */
export function toolArgsRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
