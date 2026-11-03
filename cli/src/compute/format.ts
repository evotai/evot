/** Plain-text labels shared by the Compute list, prompts and confirmations,
 *  so one machine reads the same everywhere. */

import { type CheckStatus, type ComputeCandidate, type ComputeMachine, type MachineProfile } from './types.js'

export function hardwareLabel(profile: MachineProfile | null | undefined): string {
  if (!profile) return ''
  return [
    profile.cpus > 0 ? `${profile.cpus} CPUs` : '',
    profile.mem_gb > 0 ? `${profile.mem_gb} GB` : '',
  ].filter(Boolean).join(' · ')
}

/** `Ubuntu 24.04 · 64 CPUs · 128 GB`, or empty before the first check. */
export function machineLabel(profile: MachineProfile | null | undefined): string {
  if (!profile) return ''
  return [profile.os, hardwareLabel(profile)].filter(Boolean).join(' · ')
}

export function toolsLabel(profile: MachineProfile | null | undefined): string {
  return profile?.tools.length ? profile.tools.join(' · ') : 'None found'
}

export function checkStatusLabel(status: CheckStatus): string {
  switch (status) {
    case 'ok': return 'Reachable'
    case 'unreachable': return 'Not reachable'
    case 'auth': return 'Needs a key'
    case 'needs_trust': return 'Needs first trust'
    case 'host_key_changed': return 'Host key changed'
    case 'error': return 'Check failed'
  }
}

/** A machine whose last check failed needs the user before it is used. */
export function needsAttention(machine: ComputeMachine): boolean {
  return Boolean(machine.last_check && machine.last_check.status !== 'ok')
}

const SOURCE_LABELS: Record<string, string> = {
  ssh_config: '~/.ssh/config',
  shell_history: 'shell history',
  tailscale: 'Tailscale',
}

/** One line of discovery evidence, e.g. `shell history · 77 connections`. */
export function candidateEvidence(candidate: ComputeCandidate): string {
  const sources = candidate.sources.map(source => SOURCE_LABELS[source] ?? source)
  const connections = candidate.connections > 0
    ? `${candidate.connections} connection${candidate.connections === 1 ? '' : 's'}`
    : ''
  return [...sources, connections, candidate.warning].filter(Boolean).join(' · ')
}
