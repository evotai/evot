import type { ComputeMachine } from '../../src/features/compute/types.js'

export function machine(overrides: Partial<ComputeMachine> = {}): ComputeMachine {
  return {
    id: 'm1', name: 'big-1', ssh_target: 'ubuntu@3.15.73.38',
    description: 'Rust builds and tests', enabled: true,
    profile: { os: 'Ubuntu 24.04 LTS', arch: 'x86_64', cpus: 64, mem_gb: 128, tools: ['git', 'cargo', 'docker'] },
    last_check: { checked_at: new Date().toISOString(), status: 'ok', message: '' },
    created_at: '', updated_at: '',
    ...overrides,
  }
}
