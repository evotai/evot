import type { AskUserAnswer, AskUserQuestion } from '../host-tools.js'

export interface SetupWaitHost {
  ask: (questions: AskUserQuestion[]) => Promise<AskUserAnswer[] | null>
  dismiss: () => void
}

/** Poll while a cancellable host question is visible. Timers and the question
 * are always released; a late observation can never advance a cancelled flow. */
export async function waitForSetup(
  host: SetupWaitHost,
  message: string,
  check: () => Promise<boolean>,
  signal: AbortSignal,
  intervalMs = 1500,
  timeoutMs = 180_000,
): Promise<boolean> {
  if (signal.aborted) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let finish: (value: boolean) => void = () => {}
  let fail: (error: unknown) => void = () => {}
  const observed = new Promise<boolean>((resolve, reject) => { finish = resolve; fail = reject })
  const abort = () => finish(false)
  signal.addEventListener('abort', abort, { once: true })
  const poll = async () => {
    if (settled || signal.aborted) return
    try {
      if (await check()) { finish(!signal.aborted); return }
      if (!settled) timer = setTimeout(() => { void poll() }, intervalMs)
    } catch (error) { fail(error) }
  }
  try {
    deadlineTimer = setTimeout(() => fail(new Error('Setup timed out. Your task was not created; saved channel settings are kept.')), timeoutMs)
    const answer = host.ask([{
      header: 'Feishu setup', question: message,
      options: [
        { label: 'Check again', description: 'Check saved settings and connection status.' },
        { label: 'Cancel', description: 'Cancel task creation. Saved settings are kept.' },
      ],
    }]).then(answers => !signal.aborted && answers?.[0]?.answer === 'Check again')
    void poll()
    return await Promise.race([answer, observed])
  } finally {
    settled = true
    if (timer) clearTimeout(timer)
    if (deadlineTimer) clearTimeout(deadlineTimer)
    signal.removeEventListener('abort', abort)
    host.dismiss()
  }
}
