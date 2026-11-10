/** Decoding contract for the JSON-encoded results the native Task RPCs return.
 *
 *  Split out of `client.ts` so the decode rules can be exercised without the
 *  native addon: a malformed result, or an error the Rust side already
 *  formatted, must survive the boundary with its own text. Only the RPC adapter
 *  needs the binding, so only it may load it.
 */

export function decodeTaskNativeResult<T>(raw: unknown, operation: string): T {
  if (raw instanceof Error) throw raw
  if (typeof raw !== 'string') {
    const message = raw && typeof raw === 'object' && 'message' in raw
      ? String((raw as { message: unknown }).message)
      : ''
    throw new Error(message || `${operation}: invalid native result`)
  }
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    const text = raw.trim()
    if (/^(?:Error|NapiError|GenericFailure)\b/i.test(text)) throw new Error(text)
    throw new Error(`${operation}: invalid native result`, { cause: error })
  }
}

export async function nativeJson<T>(operation: string, result: Promise<unknown>): Promise<T> {
  return decodeTaskNativeResult<T>(await result, operation)
}
