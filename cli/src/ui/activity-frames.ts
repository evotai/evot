/** One tick in the terminal and the Remote browser. */
export const SPINNER_INTERVAL_MS = 100

export function spinnerFrames(platform: string, term?: string): readonly string[] {
  const chars = term === 'xterm-ghostty' ? ['·', '✢', '✳', '✶', '✻', '*']
    : platform === 'darwin' ? ['·', '✢', '✳', '✶', '✻', '✽']
    : ['·', '✢', '*', '✶', '✻', '✽']
  return [...chars, ...chars.toReversed()]
}
