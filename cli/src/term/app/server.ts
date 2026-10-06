import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspectConsole } from '../../channels/console-client.js'
import type { BackgroundScheduler } from '../../background/scheduler.js'

export interface ServerState {
  port: number
  address: string
  channels: string[]
  startedAt: number
  envFile: string
  /** True only when this process holds the native server, not a discovered console. */
  owned: boolean
}

let activePort: number | null = null
let ownedSince: number | null = null

export async function tryStartServer(port?: number, envFile?: string): Promise<ServerState | null> {
  const { startServerBackground } = await import('../../native/index.js')
  const endpoint = await startServerBackground(port, undefined, envFile)
  if (endpoint === null) {
    const shared = await discoverDashboard(port ?? 8082, envFile)
    activePort = null
    ownedSince = null
    return shared
  }
  const snapshot = await inspectConsole(endpoint.address)
  if (activePort !== endpoint.port || ownedSince === null) ownedSince = Date.now()
  activePort = endpoint.port
  // The UI URL is surfaced as a clickable link in the banner rather than
  // auto-opened — popping a browser tab on every launch is disruptive.
  return {
    port: endpoint.port,
    address: endpoint.address,
    channels: endpoint.channels,
    envFile: snapshot.env_file_path,
    startedAt: ownedSince,
    owned: true,
  }
}

/** Reuse only a verified evot console serving this CLI's configuration.
 * Discovery does not acquire ownership; native stop still stops only our server. */
export async function discoverDashboard(port: number, envFile?: string): Promise<ServerState | null> {
  if (!envFile) return null
  const address = `http://127.0.0.1:${port}`
  try {
    const snapshot = await inspectConsole(address)
    if (canonicalPath(snapshot.env_file_path) !== canonicalPath(envFile)) return null
    return {
      port, address, channels: snapshot.feishu ? ['feishu'] : [],
      envFile: snapshot.env_file_path, startedAt: Date.now(), owned: false,
    }
  } catch {
    return null
  }
}

function canonicalPath(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}

export interface DashboardHost {
  attempt: () => Promise<ServerState | null>
  stop: () => Promise<void>
  publish: (state: ServerState | null) => void
}

/** Publish owned or verified same-config consoles; cleanup only releases ownership. */
export function registerDashboard(scheduler: BackgroundScheduler, host: DashboardHost): () => void {
  const unregister = scheduler.register({
    name: 'dashboard', intervalMs: 5000,
    run: async signal => {
      const state = await host.attempt()
      if (signal.aborted) { await host.stop(); return }
      host.publish(state)
    },
    onError: () => {
      activePort = null
      ownedSince = null
      host.publish(null)
    },
  })
  return () => {
    unregister()
    host.publish(null)
    void host.stop().catch(() => {})
  }
}

export async function stopOwnedServer(): Promise<void> {
  activePort = null
  ownedSince = null
  // @ts-ignore — generated native bindings
  const { stopServerBackground } = await import('../../native/binding.js')
  await stopServerBackground()
}

export function formatUptime(startedAt: number): string {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000)
  if (elapsed < 60) return `${elapsed}s`
  const minutes = Math.floor(elapsed / 60)
  const seconds = elapsed % 60
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  const remainMinutes = minutes % 60
  return `${hours}h${remainMinutes.toString().padStart(2, '0')}m`
}

export function ownedDashboardPort(state: ServerState | null): number | null {
  return state?.owned ? state.port : null
}

export function terminalTitle(prefix?: string): string {
  const suffix = activePort ? ` · :${activePort}` : ''
  return prefix ? `${prefix} Evot${suffix}` : `Evot${suffix}`
}

export function setTerminalTitle(prefix?: string): void {
  process.stdout.write(`\x1b]0;${terminalTitle(prefix)}\x07`)
}
