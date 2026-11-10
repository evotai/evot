import type { SetupState } from './onboarding.js'
import { consoleJson } from '../console-client.js'

async function request(address: string, body?: { revision: string; chat_id: string }): Promise<unknown> {
  const response = await consoleJson(address, '/api/channels/feishu/setup', body)
  if (response.status === 404) {
    throw new Error(`The console at ${address} needs the current evot build. Start the updated server on the same port, then continue setup.`)
  }
  if (response.status < 200 || response.status >= 300) throw new Error('Could not read or save Feishu setup. Settings may have changed; check the console and try again.')
  return response.data
}

/** Always query the process serving the settings page, not this CLI's addon.
 * An existing console may own the WebSocket and learned conversations. */
export async function observeFeishu(address: string): Promise<SetupState> {
  const state = await request(address) as SetupState
  if (typeof state?.configured !== 'boolean' || typeof state.revision !== 'string'
    || typeof state.default_chat_id !== 'string' || !Array.isArray(state.chats)
    || !state.chats.every(chat => typeof chat === 'string')
    || typeof state.connection?.state !== 'string') throw new Error('Invalid Feishu setup state')
  return state
}

export async function bindFeishuChat(address: string, revision: string, chat: string): Promise<void> {
  await request(address, { revision, chat_id: chat })
}
