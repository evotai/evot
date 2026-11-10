import type { AskUserAnswer, AskUserQuestion } from '../../host-tools.js'
import { recoverSetup } from '../setup-recovery.js'
import { bindFeishuChat, observeFeishu } from './client.js'
import { setupFeishu } from './onboarding.js'

export interface FeishuSetupHost {
  signal: AbortSignal
  consoleUrl: string
  /** May start or reuse a server. Invoked inside recovery so startup failure
   * also displays a setup step instead of failing task creation. */
  console: () => Promise<{ address: string; envFile: string }>
  envFile: () => string | undefined
  ask: (questions: AskUserQuestion[]) => Promise<AskUserAnswer[] | null>
  wait: (message: string, check: () => Promise<boolean>, signal: AbortSignal) => Promise<boolean>
}

export async function ensureFeishuDelivery(host: FeishuSetupHost): Promise<boolean> {
  return (await recoverSetup(host, async () => {
    const console = await host.console()
    if (host.signal.aborted) return false
    const expected = host.envFile()
    if (expected && console.envFile !== expected) {
      throw new Error(`The console at ${console.address} uses a different configuration file. Start the console with this CLI's configuration, then continue setup.`)
    }
    return setupFeishu({
      consoleUrl: new URL('/feishu', console.address).href,
      signal: host.signal,
      observe: () => observeFeishu(console.address),
      bind: (revision, chat) => bindFeishuChat(console.address, revision, chat),
      ask: host.ask,
      wait: host.wait,
    })
  })) ?? false
}
