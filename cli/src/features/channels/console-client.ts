/** Shared HTTP boundary for a local evot console. Credentials are entered in
 * the browser, never sent through this client's discovery/setup requests. */
export async function consoleJson(address: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const url = new URL(path, address)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password) throw new Error('Settings must use a local evot console.')
  // Bun applies proxy environment settings even to loopback requests. Preserve
  // the user's exemptions and add only this console host; never disable proxies
  // globally (cloud/model traffic still needs them).
  for (const name of ['NO_PROXY', 'no_proxy'] as const) {
    const entries = (process.env[name] ?? '').split(',').filter(Boolean)
    if (!entries.includes(url.hostname)) entries.push(url.hostname)
    process.env[name] = entries.join(',')
  }
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000), redirect: 'error',
  })
  if (!response.ok) return { status: response.status, data: null }
  return { status: response.status, data: await response.json() }
}

export interface ConsoleSnapshot {
  env_file_path: string
  feishu: null | { app_id: string; app_secret_set?: boolean; default_chat_id?: string }
}

export async function inspectConsole(address: string): Promise<ConsoleSnapshot> {
  const { status, data } = await consoleJson(address, '/api/channels/feishu')
  if (status !== 200) throw new Error('The settings port is occupied but no evot console is available there.')
  const snapshot = data as ConsoleSnapshot
  if (typeof snapshot?.env_file_path !== 'string'
    || !(snapshot.feishu === null || typeof snapshot.feishu?.app_id === 'string')) {
    throw new Error('The settings port is occupied by a different service.')
  }
  return snapshot
}
