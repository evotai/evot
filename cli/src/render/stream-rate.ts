/** Observed token reception rate, not upstream generation speed.
 * Missing timings and sub-second bursts are not useful rate samples. Never
 * substitute request duration: it includes queueing and prompt processing.
 */
export function streamTokenRate(outputTokens: number, streamingMs?: number): number | undefined {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0 ||
      streamingMs == null || !Number.isFinite(streamingMs) || streamingMs < 1000) return undefined
  return outputTokens * 1000 / streamingMs
}
