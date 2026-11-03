/** Wire shapes of the native compute RPCs. Mirrors `evot::compute` in
 *  `src/app/src/compute/model.rs`; that file owns the persistent contract. */

export type CheckStatus = 'ok' | 'unreachable' | 'auth' | 'needs_trust' | 'host_key_changed' | 'error'

export interface MachineProfile {
  os: string
  arch: string
  cpus: number
  mem_gb: number
  tools: string[]
}

export interface MachineCheck {
  checked_at: string
  status: CheckStatus
  message: string
}

export interface ComputeMachine {
  id: string
  name: string
  ssh_target: string
  description: string
  enabled: boolean
  profile: MachineProfile | null
  last_check: MachineCheck | null
  created_at: string
  updated_at: string
}

export interface ComputeCandidate {
  target: string
  host_name: string
  sources: Array<'ssh_config' | 'shell_history' | 'tailscale' | string>
  connections: number
  last_used: number | null
  warning: string
}

export interface ProbeResult {
  target: string
  check: MachineCheck
  profile: MachineProfile | null
  /** Already a Host alias in ~/.ssh/config; otherwise adding creates one. */
  ssh_alias?: boolean
}

export interface NewMachine {
  name: string
  ssh_target: string
  description: string
  profile?: MachineProfile | null
  last_check?: MachineCheck | null
}

export interface MachinePatch {
  name?: string
  description?: string
  enabled?: boolean
}
