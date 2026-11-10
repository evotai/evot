import stripAnsi from 'strip-ansi'

/** The reporting host is stored with the error, not looked up from the shared
 * executor registration. Older reports contain only a message. */
export function taskRunError(error: string): { message: string; executor: string } {
  const plain = stripAnsi(error).replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '')
  const match = plain.match(/\nExecutor: ([^\r\n]+)$/)
  return {
    message: match ? plain.slice(0, match.index) : plain,
    executor: match?.[1]?.trim() || 'Not recorded',
  }
}
