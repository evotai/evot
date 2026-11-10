import type { AskUserAnswer, AskUserQuestion } from '../host-tools.js'

export interface SetupRecoveryHost {
  signal: AbortSignal
  consoleUrl: string
  ask: (questions: AskUserQuestion[]) => Promise<AskUserAnswer[] | null>
}

/** Infrastructure failures are a setup step, not a failed task mutation. Keep
 * the draft in the caller, retry only on an explicit gesture, and never use a
 * legacy endpoint or silently disable delivery. The host renders these prompts
 * transiently rather than recording each check in conversation history. */
export async function recoverSetup<T>(
  host: SetupRecoveryHost,
  action: () => Promise<T>,
): Promise<T | null> {
  while (!host.signal.aborted) {
    try {
      const value = await action()
      return host.signal.aborted ? null : value
    } catch (error) {
      if (host.signal.aborted) return null
      const detail = error instanceof Error ? error.message : 'Could not complete setup.'
      const answers = await host.ask([{
        header: 'Feishu setup',
        question: `Setup needs attention\n${host.consoleUrl}\n${detail}\nYour task draft is kept. Fix the issue, then continue.`,
        options: [
          { label: 'Continue setup', description: 'Check again and resume this task.' },
          { label: 'Cancel', description: 'Cancel task creation. Saved settings are kept.' },
        ],
      }])
      if (host.signal.aborted || answers?.[0]?.answer !== 'Continue setup') return null
    }
  }
  return null
}
