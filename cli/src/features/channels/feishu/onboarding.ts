import type { AskUserQuestion, AskUserAnswer } from '../../host-tools.js'

export interface SetupState {
  configured: boolean
  revision: string
  default_chat_id: string
  chats: string[]
  connection: { state: string; message: string }
}

export interface SetupHost {
  consoleUrl: string
  signal: AbortSignal
  observe: () => Promise<SetupState>
  bind: (revision: string, chat: string) => Promise<void>
  ask: (questions: AskUserQuestion[]) => Promise<AskUserAnswer[] | null>
  wait: (message: string, check: () => Promise<boolean>, signal: AbortSignal) => Promise<boolean>
}

/** Channel-specific onboarding; no task fields, model calls, or credentials. */
export async function setupFeishu(host: SetupHost): Promise<boolean> {
  let page = 0
  for (;;) {
    if (host.signal.aborted) return false
    let state = await host.observe()
    if (state.configured && state.default_chat_id) return true
    if (!state.configured || state.connection.state !== 'connected') {
      const message = !state.configured
        ? `Set up Feishu push\nOpen ${host.consoleUrl}\nEnter App ID and App secret, then save. Advanced options can stay unchanged.`
        : `Connecting to Feishu\n${host.consoleUrl}\n${state.connection.message || 'Waiting for the connection.'}\nCheck bot permissions and persistent-connection event subscriptions if it cannot connect.`
      const initialRevision = state.revision
      const initialStatus = state.connection.state
      const resumed = await host.wait(message, async () => {
        state = await host.observe()
        return state.revision !== initialRevision || state.connection.state !== initialStatus
          || (state.configured && !!state.default_chat_id)
      }, host.signal)
      if (!resumed) return false
      continue
    }
    if (state.chats.length === 0) {
      const resumed = await host.wait(
        'Feishu connected\nSend a private message to your bot, for example “hi”.\nWaiting for a conversation to use for push notifications.',
        async () => {
          const next = await host.observe()
          return next.revision !== state.revision || next.chats.length > 0 || !!next.default_chat_id
            || next.connection.state !== 'connected'
        }, host.signal,
      )
      if (!resumed) return false
      continue
    }
    // Never infer ownership from a single remembered chat. Ask explicitly, even
    // for one candidate. Extra chats are entered through the standard custom answer.
    const pageSize = 2
    const pages = Math.ceil(state.chats.length / pageSize)
    page %= pages
    const visible = state.chats.slice(page * pageSize, (page + 1) * pageSize)
    const choices = visible.map(chat => ({ label: chat, description: 'Use this private conversation for push notifications.' }))
    const answers = await host.ask([{
      header: 'Push destination',
      question: `Choose your Feishu conversation (${page + 1}/${pages}).\n${visible.join('\n')}\nOnly confirm a conversation you recognize. If unsure, cancel and check with the bot administrator.`,
      options: [...choices,
        ...(pages > 1 ? [{ label: 'Next page', description: 'Show more conversations.' }] : []),
        { label: 'Cancel', description: 'Do not create the task.' }],
    }])
    if (host.signal.aborted) return false
    const selected = answers?.[0]?.answer.trim()
    if (!selected || selected === 'Cancel') return false
    if (selected === 'Next page') { page++; continue }
    if (!visible.includes(selected)) continue
    // The backend compares the generation before committing this confirmation.
    await host.bind(state.revision, selected)
    return true
  }
}
