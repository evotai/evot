import type { NativeSuggestion, SuggestionOutcome } from '../../../native/contracts/ports.js'

/** Preparation (e.g. clipboard bytes) belongs to the same cancellable request.
 * Cancelling does not cancel the paste itself or later submit it. */
export function prepareSuggestion(prepare: (signal: AbortSignal) => Promise<NativeSuggestion>, timeoutMs = 30_000): NativeSuggestion {
  const abort = new AbortController()
  let native: NativeSuggestion | undefined
  let cancel!: (status: 'empty' | 'timed_out') => void
  const stopped = new Promise<SuggestionOutcome>(resolve => { cancel = status => resolve({ candidates: [], status }) })
  const stop = (status: 'empty' | 'timed_out') => { abort.abort(); cancel(status); native?.abort(); clearTimeout(timer) }
  const timer = setTimeout(() => stop('timed_out'), timeoutMs)
  timer.unref()
  const cancelled = stopped.then(() => null)
  const ready = Promise.race([
    Promise.resolve().then(() => prepare(abort.signal)).then(request => {
      native = request
      if (abort.signal.aborted) request.abort()
      return abort.signal.aborted ? null : request
    }),
    cancelled,
  ])
  let outcome: Promise<SuggestionOutcome> | undefined
  const result = () => outcome ??= Promise.race([ready.then(async (request): Promise<SuggestionOutcome> => {
    if (!request) return stopped
    if (request.outcome) return request.outcome()
    const text = await request.result()
    return { candidates: text ? [text] : [], status: text ? 'ready' : 'empty' }
  }), stopped]).finally(() => clearTimeout(timer))
  return {
    abort: () => stop('empty'),
    outcome: result,
    result: async () => (await result()).candidates[0] ?? null,
    nextCandidates: async () => (await ready)?.nextCandidates?.() ?? null,
  }
}

/** Drain validated candidate updates without polling or starting extra model
 * calls. Final outcome remains authoritative, including transport failures.
 * Older addons simply use the existing final-result path. */
export async function readSuggestion(
  request: NativeSuggestion,
  update: (candidates: string[]) => void,
): Promise<SuggestionOutcome> {
  let finished = false
  if (request.nextCandidates) {
    const next = request.nextCandidates.bind(request)
    void (async () => {
      while (!finished) {
        const candidates = await next()
        if (finished || candidates === null) return
        update(candidates)
      }
    })().catch(() => {
      // The outcome reports any provider/addon error. Progress is optional.
    })
  }
  try {
    if (request.outcome) return await request.outcome()
    const text = await request.result()
    return { candidates: typeof text === 'string' ? [text] : [], status: text ? 'ready' : 'empty' }
  } finally {
    finished = true
  }
}
