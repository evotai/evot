/**
 * Mirror of `evotengine::context::window::usage_is_plausible`.
 *
 * A provider-reported context size that dwarfs the engine's local estimate of
 * the same request (e.g. a gateway summing a whole run's prompt tokens into
 * the last response) does not describe that request. The footer keeps the
 * estimate instead of jumping to a number several times the context window.
 * The bound is loose on purpose: CJK text and images legitimately count well
 * above the chars/4 heuristic.
 */
export const USAGE_PLAUSIBILITY_FACTOR = 4
export const USAGE_PLAUSIBILITY_SLACK_TOKENS = 16_000

export function usageIsPlausible(reportedTokens: number, localEstimate: number): boolean {
  return reportedTokens <= localEstimate * USAGE_PLAUSIBILITY_FACTOR + USAGE_PLAUSIBILITY_SLACK_TOKENS
}
